import "server-only";
import path from "node:path";
import { z } from "zod";

const reportAssetSchema = z.object({
  fileName: z.string(),
  contentType: z.string(),
  base64: z.string(),
  createdAt: z.string(),
});

const contentType = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

function reportKey(fileName: string) {
  const safeName = path.basename(fileName);
  if (!safeName.endsWith(".pptx")) throw new Error("Invalid report file name");
  return `reports/generated/${safeName}`;
}

function relationalEnabled() {
  return process.env.DATA_BACKEND === "supabase-relational" || process.env.SUPABASE_DATA_MODEL === "relational";
}

function missingStorageError(action: string) {
  return new Error(`Supabase storage is required to ${action} generated reports.`);
}

async function store() {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw missingStorageError("access");
  }
  return import("./store");
}

export async function saveGeneratedReport(fileName: string, bytes: Uint8Array) {
  const key = reportKey(fileName);
  const asset = {
    fileName: path.basename(fileName),
    contentType,
    base64: Buffer.from(bytes).toString("base64"),
    createdAt: new Date().toISOString(),
  };
  if (relationalEnabled()) {
    await (await import("./relational-store")).saveGeneratedReportAsset(asset);
    return key;
  }
  const { setStore } = await store();
  await setStore(key, asset);
  return key;
}

export async function readGeneratedReport(outputPath: string) {
  const fileName = path.basename(outputPath);
  const key = reportKey(fileName);
  if (relationalEnabled()) {
    const asset = await (await import("./relational-store")).readGeneratedReportAsset(fileName);
    if (!asset) throw new Error("Generated report file not found");
    return {
      fileName: asset.fileName,
      contentType: asset.contentType || contentType,
      bytes: Buffer.from(asset.base64, "base64"),
    };
  }
  const { getStore } = await store();
  const raw = await getStore<unknown>(key);
  if (raw === undefined) throw new Error("Generated report file not found");
  const asset = reportAssetSchema.parse(raw);
  return {
    fileName: asset.fileName,
    contentType: asset.contentType || contentType,
    bytes: Buffer.from(asset.base64, "base64"),
  };
}
