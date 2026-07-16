import { z } from "zod";
import { readJson } from "./json-store";

export const importMappingsSchema = z.object({
  snow: z.record(z.string(), z.string()),
  supportdesk: z.object({
    customerAliases: z.record(z.string(), z.string()).default({}),
  }).default({ customerAliases: {} }),
});

export type ImportMappings = z.infer<typeof importMappingsSchema>;

export const defaultImportMappings: ImportMappings = {
  snow: {
    issueId: "Issue ID",
    date: "Date",
    customer: "Customer",
    issueTitle: "Issue Title",
    issueType: "Issue Type",
    severity: "Severity",
    owner: "Owner",
    status: "Status",
    startDate: "Start Date",
    dueDate: "Due Date",
    closeDate: "Close Date",
    mdUsed: "MD Used",
    chargeable: "Chargeable",
    remark: "Remark",
  },
  supportdesk: {
    customerAliases: {},
  },
};

function mergeImportMappings(runtime: Partial<ImportMappings>): ImportMappings {
  return importMappingsSchema.parse({
    snow: { ...defaultImportMappings.snow, ...(runtime.snow || {}) },
    supportdesk: {
      customerAliases: {
        ...defaultImportMappings.supportdesk.customerAliases,
        ...(runtime.supportdesk?.customerAliases || {}),
      },
    },
  });
}

export async function loadImportMappings(overrides?: Partial<ImportMappings>) {
  if (overrides) return mergeImportMappings(overrides);
  try {
    const runtime = await readJson("imports/mappings.json", importMappingsSchema);
    return mergeImportMappings(runtime);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const message = error instanceof Error ? error.message : "";
    const optionalRuntimeMappingMissing =
      code === "ENOENT" ||
      message.startsWith("Supabase storage is required to read imports/mappings.json");
    if (!optionalRuntimeMappingMissing) throw error;
    return defaultImportMappings;
  }
}
