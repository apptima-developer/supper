import process from "node:process";
import { inspectRuntimeAssets } from "./runtime-asset-inventory.mjs";

const root = process.cwd();

let missingRequired = 0;

console.log("Runtime asset verification");
console.log("==========================");

for (const asset of inspectRuntimeAssets(root)) {
  const marker = asset.exists ? "OK" : asset.required ? "MISSING" : "OPTIONAL";
  const suffix = asset.required ? "required" : "optional";
  console.log(`${marker.padEnd(8)} ${asset.label} (${suffix})`);
  console.log(`         ${asset.path}`);
  if (!asset.exists && asset.required) missingRequired += 1;
}

if (missingRequired) {
  console.error(`\n${missingRequired} required runtime asset(s) are missing. Restore the listed files before using import/report runtime flows.`);
  process.exitCode = 1;
} else {
  console.log("\nAll required runtime assets are present.");
}
