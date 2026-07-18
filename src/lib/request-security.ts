import { NextResponse } from "next/server";
import { z, type ZodType } from "zod";
import { getRequestLimits } from "./env";
import { isValidRequestId, REQUEST_ID_HEADER, resolveRequestId } from "./request-id";
import { logServerError } from "./server-logging";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function requestId(request?: Request) {
  return resolveRequestId(request?.headers.get(REQUEST_ID_HEADER));
}

export function withRequestId(response: NextResponse, correlationId: string) {
  response.headers.set(REQUEST_ID_HEADER, correlationId);
  return response;
}

export function jsonResponseWithRequestId(
  body: Record<string, unknown>,
  request?: Request,
  init: ResponseInit = {},
  correlationId?: string,
) {
  const id = correlationId && isValidRequestId(correlationId) ? correlationId : requestId(request);
  const headers = new Headers(init.headers);
  headers.set(REQUEST_ID_HEADER, id);
  return NextResponse.json({ ...body, requestId: id }, { ...init, headers });
}

export function safeErrorResponse(
  error: unknown,
  fallbackMessage: string,
  request?: Request,
  fallbackStatus = 500,
  correlationId?: string,
) {
  const id = correlationId && isValidRequestId(correlationId) ? correlationId : requestId(request);
  let status = fallbackStatus;
  let code = fallbackStatus >= 500 ? "INTERNAL_ERROR" : "INVALID_REQUEST";
  let message = fallbackMessage;
  let issues: Array<{ path: string; message: string }> | undefined;

  const expectedError = error instanceof HttpError || error instanceof z.ZodError;
  if (error instanceof HttpError) {
    status = error.status;
    code = error.code;
    message = error.message;
  } else if (error instanceof z.ZodError) {
    status = 400;
    code = "VALIDATION_ERROR";
    message = "Invalid request data";
    issues = error.issues.slice(0, 20).map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    }));
  }

  if (!expectedError || status >= 500) {
    let route: string | undefined;
    try {
      route = request ? new URL(request.url).pathname : undefined;
    } catch {
      route = undefined;
    }
    logServerError("api_request_failed", error, { requestId: id, route, status });
  }
  return jsonResponseWithRequestId(
    { error: message, code, requestId: id, ...(issues ? { issues } : {}) },
    request,
    { status },
    id,
  );
}

export function assertContentLength(request: Request, maxBytes: number) {
  const value = request.headers.get("content-length");
  if (!value) return;
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size < 0) throw new HttpError(400, "INVALID_CONTENT_LENGTH", "Invalid Content-Length header");
  if (size > maxBytes) throw new HttpError(413, "REQUEST_TOO_LARGE", "Request body is too large");
}

export async function readLimitedBodyBytes(request: Request, maxBytes: number) {
  assertContentLength(request, maxBytes);
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new HttpError(413, "REQUEST_TOO_LARGE", "Request body is too large");
    }
    chunks.push(value);
  }

  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export const maximumLoginBodyBytes = 16 * 1024;

export async function readLoginFormBody(request: Request, maximumBytes = maximumLoginBodyBytes) {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/x-www-form-urlencoded") {
    throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/x-www-form-urlencoded");
  }

  const bytes = await readLimitedBodyBytes(request, maximumBytes);
  let body: string;
  try {
    body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new HttpError(400, "INVALID_FORM_BODY", "Request body must contain valid form data");
  }
  if (/%(?![0-9a-f]{2})/i.test(body)) {
    throw new HttpError(400, "INVALID_FORM_BODY", "Request body must contain valid form data");
  }

  const form = new URLSearchParams(body);
  return {
    username: form.get("username") || "",
    password: form.get("password") || "",
  };
}

export async function readJsonBody<T>(request: Request, schema: ZodType<T>, maximumBytes = getRequestLimits().maxJsonBodyBytes): Promise<T> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json");
  }
  const bytes = await readLimitedBodyBytes(request, maximumBytes);
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HttpError(400, "INVALID_JSON", "Request body must contain valid JSON");
  }
  return schema.parse(raw);
}

const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);

export function isSafeMethod(method: string) {
  return safeMethods.has(method.toUpperCase());
}

export function isSameOriginRequest({
  method,
  requestUrl,
  origin,
  configuredOrigin,
}: {
  method: string;
  requestUrl: string;
  origin: string | null;
  configuredOrigin: string | null;
}) {
  if (isSafeMethod(method)) return true;
  if (!origin) return false;
  try {
    const expected = configuredOrigin || new URL(requestUrl).origin;
    return new URL(origin).origin === expected;
  } catch {
    return false;
  }
}
