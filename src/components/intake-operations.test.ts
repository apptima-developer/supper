import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(path.join(process.cwd(), "src/components/intake-operations.tsx"), "utf8");

describe("Unified Intake Operations UI boundary", () => {
  it("contains every safe operations section and responsive presentation", () => {
    for (const label of ["Overview", "Channels", "Identities", "Conversations", "Inbound Events", "Outbox", "Diagnostics"]) expect(source).toContain(label);
    expect(source).toContain("md:hidden"); expect(source).toContain("hidden overflow-x-auto md:block");
  });

  it("states milestone limitations and uses Sonner rather than browser alerts", () => {
    expect(source).toContain("No live LINE, email, or outbound provider is connected");
    expect(source).toContain("No worker is active in AI-1.3");
    expect(source).toContain("toast."); expect(source).not.toMatch(/window\.alert|\balert\(/);
  });

  it("does not request or render forbidden sensitive fields", () => {
    expect(source).not.toMatch(/external_subject_id|provider_locator|storage_object_key|target_references|body_html|dangerouslySetInnerHTML/i);
  });
});
