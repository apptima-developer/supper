import fs from "node:fs";
import path from "node:path";

export const runtimeAssets = Object.freeze([
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
]);

export function inspectRuntimeAssets(root, exists = fs.existsSync) {
  return runtimeAssets.map((asset) => ({
    ...asset,
    exists: exists(path.join(root, asset.path)),
  }));
}
