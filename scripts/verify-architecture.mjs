import process from "node:process";
import { verifyArchitecture } from "./architecture-verifier.mjs";

const result = verifyArchitecture(process.cwd());
console.log("Architecture verification");
console.log("=========================");
for (const check of result.checks) {
  console.log(`${check.valid ? "OK" : "FAIL"}  ${check.name}: ${check.detail}`);
}
if (result.failures.length) process.exitCode = 1;
else console.log("\nArchitecture boundaries are valid and provider-neutral.");
