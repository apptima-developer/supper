export const REQUEST_ID_HEADER = "X-Request-ID";

const requestIdPattern = /^[A-Za-z0-9._-]{8,100}$/;

export function isValidRequestId(value: unknown): value is string {
  return typeof value === "string" && requestIdPattern.test(value);
}

export function resolveRequestId(
  supplied?: string | null,
  generate: () => string = () => crypto.randomUUID(),
) {
  const candidate = supplied?.trim();
  return candidate && isValidRequestId(candidate) ? candidate : generate();
}
