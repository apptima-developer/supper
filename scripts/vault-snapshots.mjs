// Local operator CLI: Vite loads existing TypeScript modules without adding a runtime dependency.
import { createServer } from "vite";
import { readFile } from "node:fs/promises";
const server = await createServer({ configFile: false, server: { middlewareMode: true }, appType: "custom" });
try {
  const { VaultAuthority } = await server.ssrLoadModule("/src/lib/snapshots/vault.ts");
  const authority = new VaultAuthority();
  const [command, file, digest] = process.argv.slice(2);
  if (command === "init") { await authority.initialize(); console.log(JSON.stringify(await authority.readiness())); }
  else if (command === "ready") console.log(JSON.stringify(await authority.readiness()));
  else if (command === "save" && file) console.log(JSON.stringify(await authority.save(JSON.parse(await readFile(file, "utf8")))));
  else if (command === "verify" && file) { await authority.readiness(); console.log(JSON.stringify((await authority.read(file)).metadata)); }
  else if (command === "export" && file && digest) console.log(JSON.stringify(await authority.export(file, digest)));
  else if (command === "catalog" && file) { const { name, backupPaths } = JSON.parse(await readFile(file,"utf8")); console.log(JSON.stringify(await authority.catalog(name,backupPaths))); }
  else if (command === "prune" && file) console.log(JSON.stringify(await authority.prune(JSON.parse(await readFile(file,"utf8")), digest)));
  else throw new Error("Usage: node scripts/vault-snapshots.mjs init|ready|save input.json|verify backupPath|export backupPath filename.json|catalog input.json|prune request.json [approved-plan-digest]");
} catch (e) { console.error(e instanceof SyntaxError ? "Invalid JSON input; payload withheld" : e instanceof Error ? e.message : "Vault operation failed"); process.exitCode = 1; }
finally { await server.close(); }
