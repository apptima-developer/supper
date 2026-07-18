import process from "node:process";
import { pathToFileURL } from "node:url";

const applicationName = "SUPPER Support Control System";
const requestIdPattern = /^[A-Za-z0-9._-]{8,100}$/;

export function normalizeBaseUrl(value) {
  if (!value?.trim()) throw new Error("SMOKE_BASE_URL is required");
  const url = new URL(value.trim());
  if (!new Set(["http:", "https:"]).has(url.protocol) || url.username || url.password) {
    throw new Error("SMOKE_BASE_URL must be an HTTP or HTTPS origin without credentials");
  }
  return url.origin;
}

function pass(name, explanation) {
  return { name, status: "PASS", explanation };
}

function fail(name, explanation) {
  return { name, status: "FAIL", explanation };
}

function correlated(response, body) {
  const header = response.headers.get("x-request-id");
  return Boolean(header && requestIdPattern.test(header) && body?.requestId === header);
}

export async function validateLiveResponse(response) {
  if (response.status !== 200) return fail("Liveness", `unexpected HTTP ${response.status}`);
  if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) return fail("Liveness", "expected JSON response");
  let body;
  try {
    body = await response.json();
  } catch {
    return fail("Liveness", "invalid JSON response");
  }
  if (body.application !== applicationName || body.status !== "live" || !body.version) return fail("Liveness", "unexpected health identity or status");
  if (!correlated(response, body)) return fail("Liveness", "missing or invalid request correlation");
  return pass("Liveness", "HTTP 200 and correlated live status");
}

export async function validateReadyResponse(response, expectedBackend) {
  if (response.status !== 200) return fail("Readiness", `unexpected HTTP ${response.status}`);
  if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) return fail("Readiness", "expected JSON response");
  let body;
  try {
    body = await response.json();
  } catch {
    return fail("Readiness", "invalid JSON response");
  }
  if (body.application !== applicationName || body.status !== "ready") return fail("Readiness", "application is not ready");
  if (expectedBackend && body.backend !== expectedBackend) return fail("Readiness", "backend does not match SMOKE_EXPECT_BACKEND");
  if (!correlated(response, body)) return fail("Readiness", "missing or invalid request correlation");
  return pass("Readiness", "HTTP 200 and correlated ready status");
}

export function validateLoginResponse(response) {
  if (response.status !== 200) return fail("Login page", `unexpected HTTP ${response.status}`);
  if (!response.headers.get("content-type")?.toLowerCase().includes("text/html")) return fail("Login page", "expected HTML response");
  return pass("Login page", "HTTP 200 HTML response");
}

async function fetchWithTimeout(fetchImpl, url, timeoutMs) {
  return fetchImpl(url, {
    method: "GET",
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: "application/json, text/html;q=0.9" },
  });
}

export async function runSmokeTest({
  baseUrl,
  expectedBackend,
  fetchImpl = fetch,
  timeoutMs = 8_000,
}) {
  const origin = normalizeBaseUrl(baseUrl);
  const targets = [
    ["Liveness", "/api/health/live"],
    ["Readiness", "/api/health/ready"],
    ["Login page", "/login"],
  ];
  const responses = await Promise.all(targets.map(async ([name, pathname]) => {
    try {
      return { name, response: await fetchWithTimeout(fetchImpl, `${origin}${pathname}`, timeoutMs) };
    } catch {
      return { name, response: null };
    }
  }));

  const byName = Object.fromEntries(responses.map((entry) => [entry.name, entry.response]));
  return [
    byName.Liveness ? await validateLiveResponse(byName.Liveness) : fail("Liveness", "request failed or timed out"),
    byName.Readiness ? await validateReadyResponse(byName.Readiness, expectedBackend) : fail("Readiness", "request failed or timed out"),
    byName["Login page"] ? validateLoginResponse(byName["Login page"]) : fail("Login page", "request failed or timed out"),
  ];
}

async function main() {
  let results;
  try {
    results = await runSmokeTest({
      baseUrl: process.env.SMOKE_BASE_URL,
      expectedBackend: process.env.SMOKE_EXPECT_BACKEND,
    });
  } catch {
    results = [fail("Smoke configuration", "SMOKE_BASE_URL is missing or invalid")];
  }
  for (const item of results) console.log(`${item.status.padEnd(5)} ${item.name} - ${item.explanation}`);
  if (results.some((item) => item.status === "FAIL")) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
