import "server-only";
import { randomBytes } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";
import { z } from "zod";
import type { Session } from "../../../auth";
import { getSessionSecret } from "../../../env";
import { HttpError } from "../../../request-security";
import {
  serviceNowOperationReferenceSchema,
  serviceNowSourceEntityReferenceSchema,
  serviceNowWriteCommandTypeSchema,
} from "./schemas";
import type {
  ServiceNowManualOperationIdentity,
  ServiceNowWriteCommandType,
} from "./types";

const tokenLifetimeSeconds = 5 * 60;
const tokenAudience = "supper-servicenow-write";
const tokenIssuer = "supper";
const manualOperationClaimsSchema = z.object({
  sub: z.string().min(1).max(200),
  aud: z.union([z.literal(tokenAudience), z.array(z.literal(tokenAudience)).length(1)]),
  iss: z.literal(tokenIssuer),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
  jti: z.string().regex(/^[a-f0-9]{64}$/),
  version: z.literal("servicenow-manual-operation-v1"),
  operationReference: serviceNowOperationReferenceSchema.regex(/^manual-op:[a-f0-9]{64}$/),
  commandType: serviceNowWriteCommandTypeSchema,
  sourceType: z.literal("manual"),
  sourceEntityReference: serviceNowSourceEntityReferenceSchema.optional(),
  environment: z.string().min(1).max(200),
}).passthrough();

type Environment = Record<string, string | undefined>;

function signingKey(env: Environment) {
  return new TextEncoder().encode(getSessionSecret(env));
}

export function serviceNowWriteEnvironment(env: Environment) {
  const values = [
    env.APP_ENV || "unspecified",
    env.VERCEL_ENV || "local",
    env.NODE_ENV || "development",
  ].map((value) => value.trim().toLowerCase().replaceAll("_", "-"));
  const environment = values.join(":");
  if (!/^[a-z0-9.:-]{1,200}$/.test(environment)) {
    throw new HttpError(503, "SERVICENOW_WRITE_ENVIRONMENT_INVALID", "ServiceNow write environment is invalid");
  }
  return environment;
}

export async function issueManualOperationIdentity(input: {
  session: Session;
  commandType: ServiceNowWriteCommandType;
  sourceEntityReference?: string;
}, dependencies: {
  env?: Environment;
  now?: () => Date;
  randomHex?: () => string;
} = {}): Promise<ServiceNowManualOperationIdentity> {
  const env = dependencies.env || process.env;
  const now = (dependencies.now || (() => new Date()))();
  const issuedAt = Math.floor(now.getTime() / 1000);
  const expiresAtSeconds = issuedAt + tokenLifetimeSeconds;
  const randomHex = dependencies.randomHex || (() => randomBytes(32).toString("hex"));
  const operationReference = `manual-op:${randomHex()}`;
  const jti = randomHex();
  const claims = {
    version: "servicenow-manual-operation-v1" as const,
    operationReference,
    commandType: input.commandType,
    sourceType: "manual" as const,
    ...(input.sourceEntityReference ? { sourceEntityReference: input.sourceEntityReference } : {}),
    environment: serviceNowWriteEnvironment(env),
  };
  const operationToken = await new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(input.session.userId)
    .setAudience(tokenAudience)
    .setIssuer(tokenIssuer)
    .setJti(jti)
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAtSeconds)
    .sign(signingKey(env));
  return {
    operationToken,
    operationReference,
    expiresAt: new Date(expiresAtSeconds * 1000).toISOString(),
  };
}

export async function resolveManualOperationIdentity(input: {
  operationToken: string;
  session: Session;
  commandType: ServiceNowWriteCommandType;
  sourceEntityReference?: string;
}, dependencies: {
  env?: Environment;
  now?: () => Date;
} = {}) {
  const env = dependencies.env || process.env;
  try {
    const { payload } = await jwtVerify(input.operationToken, signingKey(env), {
      algorithms: ["HS256"],
      audience: tokenAudience,
      issuer: tokenIssuer,
      currentDate: (dependencies.now || (() => new Date()))(),
    });
    const claims = manualOperationClaimsSchema.parse(payload);
    if (claims.sub !== input.session.userId
      || claims.commandType !== input.commandType
      || claims.sourceType !== "manual"
      || claims.environment !== serviceNowWriteEnvironment(env)
      || (claims.sourceEntityReference || undefined) !== (input.sourceEntityReference || undefined)) {
      throw new Error("scope mismatch");
    }
    return {
      operationReference: claims.operationReference,
      expiresAt: new Date(claims.exp * 1000).toISOString(),
    };
  } catch {
    throw new HttpError(
      409,
      "SERVICENOW_WRITE_MANUAL_OPERATION_INVALID",
      "Manual operation identity is missing, expired, or does not match this command",
    );
  }
}
