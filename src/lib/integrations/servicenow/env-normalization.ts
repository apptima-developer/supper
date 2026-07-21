import { z } from "zod";

const asciiEdgeWhitespace = /^[\t\n\f\r ]+|[\t\n\f\r ]+$/g;

export function trimAsciiEnvironmentValue(value: string | undefined) {
  return value?.replace(asciiEdgeWhitespace, "");
}

export function normalizeLowerEnvironmentValue(value: string | undefined) {
  return trimAsciiEnvironmentValue(value)?.toLowerCase();
}

export function environmentValueOrDefault(value: string | undefined, fallback: string | number) {
  return trimAsciiEnvironmentValue(value) || fallback;
}

export const disabledByDefaultBooleanSchema = z.preprocess((value) => {
  if (value === undefined || value === null) return "false";
  if (typeof value !== "string") return value;
  return normalizeLowerEnvironmentValue(value) || "false";
}, z.enum(["true", "false"])).transform((value) => value === "true");

export function parseDisabledByDefaultBoolean(value: string | undefined) {
  return disabledByDefaultBooleanSchema.parse(value);
}
