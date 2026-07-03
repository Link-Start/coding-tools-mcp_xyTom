import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BatonManager, formatBatonBundle, readBatonBundle } from "../src/baton/protocol.js";

describe("baton protocol", () => {
  it("writes and reads the constrained handoff files", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctc-baton-"));
    const baton = new BatonManager(() => root);

    const plan = await baton.writePlan({ content: "# Plan\n\n- Build M4\n" });
    const status = await baton.updateStatus({ phase: "M4", step: "baton", state: "in_progress", note: "testing" });
    const report = await baton.writeReport({ content: "# Report\n\nDone.\n" });

    expect(plan.path).toBe(join(root, ".baton", "plan.md"));
    expect(report.path).toBe(join(root, ".baton", "report.md"));
    expect(status).toEqual(expect.objectContaining({ phase: "M4", state: "in_progress", note: "testing" }));
    expect(existsSync(join(root, ".baton", "artifacts"))).toBe(true);

    await expect(readFile(join(root, ".baton", "status.json"), "utf8")).resolves.toContain("updatedAt");
    await expect(baton.readPlan()).resolves.toMatchObject({ exists: true, content: "# Plan\n\n- Build M4\n" });

    const bundle = await readBatonBundle(root);
    expect(formatBatonBundle(bundle)).toContain("phase: M4");
    expect(formatBatonBundle(bundle)).toContain("# Report");
  });
});
