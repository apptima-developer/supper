import process from "node:process";
import {
  compareProductionDataSnapshots,
  readIntegrityManifest,
  snapshotProductionData,
} from "./production-data-integrity.mjs";

function argumentValue(name) {
  const inline = process.argv.find((argument) => argument.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const root = argumentValue("--root") ?? process.cwd();
const manifestPath = argumentValue("--manifest");
const before = manifestPath ? readIntegrityManifest(manifestPath) : snapshotProductionData(root);
const after = snapshotProductionData(root);
const failures = compareProductionDataSnapshots(before, after);

console.log("Production data integrity verification");
console.log("======================================");
console.log(`Scope: ${Object.keys(after.files).length} active JSON data file(s)`);
console.log("Excluded: backups, generated reports, monthly exports, logs, fixtures, and temporary files");
if (failures.length) {
  for (const failure of failures) console.error(`FAIL  ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`OK    ${manifestPath ? "matches the supplied read-only manifest" : "read-only before/after snapshot is unchanged"}`);
}
