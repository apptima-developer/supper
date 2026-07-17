const sensitiveKeyPattern = /(password|passwordhash|secret|pepper|token|authorization|cookie|api[_-]?key|service[_-]?role|dataurl|base64|filecontent)/i;

function sanitize(value: unknown, depth: number): unknown {
  if (depth > 4) return "[truncated]";
  if (value instanceof Error) return { type: value.name || "Error" };
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitize(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      sensitiveKeyPattern.test(key) ? "[redacted]" : sanitize(item, depth + 1),
    ]));
  }
  if (typeof value === "string" && value.length > 500) return `${value.slice(0, 500)}[truncated]`;
  return value;
}

export function redactSensitive(value: unknown) {
  return sanitize(value, 0);
}

export function logServerError(event: string, error: unknown, context: Record<string, unknown> = {}) {
  console.error(JSON.stringify({
    level: "error",
    event,
    error: sanitize(error, 0),
    context: sanitize(context, 0),
    timestamp: new Date().toISOString(),
  }));
}

export function logServerCritical(event: string, error: unknown, context: Record<string, unknown> = {}) {
  console.error(JSON.stringify({
    level: "critical",
    event,
    error: sanitize(error, 0),
    context: sanitize(context, 0),
    timestamp: new Date().toISOString(),
  }));
}
