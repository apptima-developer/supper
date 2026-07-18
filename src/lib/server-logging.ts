import { isValidRequestId } from "./request-id";

const sensitiveKeyPattern = /(password|passwordhash|secret|pepper|token|authorization|cookie|api[_-]?key|service[_-]?role|dataurl|base64|filecontent|email|username|actor|ticket[_-]?title|customer[_-]?name|report[_-]?rows)/i;

function sanitize(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (depth > 4) return "[truncated]";
  if (value instanceof Error) return { type: value.name || "Error" };
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : "[invalid-date]";
  if (typeof value === "bigint") return `${value.toString()}n`;
  if (typeof value === "symbol" || typeof value === "function") return "[unsupported]";
  if (typeof value === "number" && !Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    return value.slice(0, 20).map((item) => sanitize(item, depth + 1, seen));
  }
  if (value && typeof value === "object") {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    const output: Record<string, unknown> = {};
    let keys: string[];
    try {
      keys = Object.keys(value).slice(0, 50);
    } catch {
      return "[unreadable]";
    }
    for (const key of keys) {
      if (sensitiveKeyPattern.test(key)) {
        output[key] = "[redacted]";
        continue;
      }
      try {
        output[key] = sanitize((value as Record<string, unknown>)[key], depth + 1, seen);
      } catch {
        output[key] = "[unreadable]";
      }
    }
    return output;
  }
  if (typeof value === "string" && value.length > 500) return `${value.slice(0, 500)}[truncated]`;
  return value;
}

export function redactSensitive(value: unknown) {
  try {
    return sanitize(value, 0, new WeakSet());
  } catch {
    return "[unreadable]";
  }
}

function safeOperationalLabel(value: unknown) {
  return typeof value === "string" && value.length <= 160 && /^[A-Za-z0-9_./:-]+$/.test(value) ? value : undefined;
}

function writeServerLog(level: "error" | "critical", event: string, error: unknown, context: Record<string, unknown>) {
  try {
    const requestId = isValidRequestId(context.requestId) ? context.requestId : undefined;
    const route = safeOperationalLabel(context.route);
    const operation = safeOperationalLabel(context.operation);
    console.error(JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      event: safeOperationalLabel(event) || "server_event",
      ...(requestId ? { requestId } : {}),
      ...(route ? { route } : {}),
      ...(operation ? { operation } : {}),
      error: redactSensitive(error),
      context: redactSensitive(context),
    }));
  } catch {
    try {
      console.error("{\"level\":\"error\",\"event\":\"server_logging_failed\"}");
    } catch {
      // Logging must never change application behavior.
    }
  }
}

export function logServerError(event: string, error: unknown, context: Record<string, unknown> = {}) {
  writeServerLog("error", event, error, context);
}

export function logServerCritical(event: string, error: unknown, context: Record<string, unknown> = {}) {
  writeServerLog("critical", event, error, context);
}
