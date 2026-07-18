import process from "node:process";
import { collectBuildEnvironmentChecks } from "./build-environment-verifier.mjs";

async function main() {
  const checks = await collectBuildEnvironmentChecks();
  for (const item of checks) {
    console.log(`${item.status.padEnd(8)} ${item.name} - ${item.explanation}`);
  }
  if (checks.some((item) => item.status === "FAIL")) process.exitCode = 1;
}

main().catch(() => {
  console.error("FAIL     Build environment verification - unexpected verifier failure");
  process.exitCode = 1;
});
