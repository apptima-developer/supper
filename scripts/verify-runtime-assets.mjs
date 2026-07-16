import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();

const assets = [
  {
    label: "Import mapping source defaults",
    path: "src/lib/import-mappings.ts",
    required: true,
  },
  {
    label: "Runtime import mapping override",
    path: "data/imports/mappings.json",
    required: false,
  },
  {
    label: "Manday summary Excel template",
    path: "templates/reports/manday-summary-template.xlsx",
    required: true,
  },
  {
    label: "Support service monthly report Excel template",
    path: "templates/reports/support-service-monthly-report-template.xlsx",
    required: true,
  },
];

let missingRequired = 0;

console.log("Runtime asset verification");
console.log("==========================");

for (const asset of assets) {
  const absolutePath = path.join(root, asset.path);
  const exists = fs.existsSync(absolutePath);
  const marker = exists ? "OK" : asset.required ? "MISSING" : "OPTIONAL";
  const suffix = asset.required ? "required" : "optional";
  console.log(`${marker.padEnd(8)} ${asset.label} (${suffix})`);
  console.log(`         ${asset.path}`);
  if (!exists && asset.required) missingRequired += 1;
}

if (missingRequired) {
  console.error(`\n${missingRequired} required runtime asset(s) are missing. Restore the listed files before using import/report runtime flows.`);
  process.exitCode = 1;
} else {
  console.log("\nAll required runtime assets are present.");
}
