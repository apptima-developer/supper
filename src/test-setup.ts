import { vi } from "vitest";
// Node tests exercise server modules outside Next's React server bundler.
vi.mock("server-only", () => ({}));
