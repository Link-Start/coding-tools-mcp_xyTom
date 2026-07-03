import { describe, expect, it } from "vitest";
import { summarizeArgs } from "../src/shared/summarize.js";

describe("summarizeArgs", () => {
  it("redacts secret-like fields", () => {
    const summary = summarizeArgs({ token: "abc", nested: { password: "def", path: "src/index.ts" } });
    expect(summary).toContain("[redacted]");
    expect(summary).toContain("src/index.ts");
    expect(summary).not.toContain("abc");
    expect(summary).not.toContain("def");
  });

  it("clips very large payloads", () => {
    const summary = summarizeArgs({ text: "x".repeat(2000) }, 100);
    expect(summary.length).toBeLessThanOrEqual(100);
    expect(summary).toContain("truncated");
  });
});
