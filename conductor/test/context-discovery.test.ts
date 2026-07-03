import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverWorkspaceContext, loadWorkspaceSkill } from "../src/context/discovery.js";

describe("workspace context discovery", () => {
  it("discovers instruction files and workspace skills", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctc-context-"));
    await mkdir(join(root, "packages", "app"), { recursive: true });
    await mkdir(join(root, ".ctc", "skills", "reviewer"), { recursive: true });
    await mkdir(join(root, ".claude", "skills", "reviewer"), { recursive: true });
    await mkdir(join(root, ".claude", "skills", "writer"), { recursive: true });

    await writeFile(join(root, "AGENTS.md"), "Root rules\n", "utf8");
    await writeFile(join(root, "packages", "app", "CLAUDE.md"), "Nested rules\n", "utf8");
    await writeFile(
      join(root, ".ctc", "skills", "reviewer", "SKILL.md"),
      "---\ndescription: Review code changes\n---\n# Reviewer\n",
      "utf8",
    );
    await writeFile(
      join(root, ".claude", "skills", "reviewer", "SKILL.md"),
      "---\ndescription: Shadowed reviewer\n---\n# Reviewer\n",
      "utf8",
    );
    await writeFile(
      join(root, ".claude", "skills", "writer", "SKILL.md"),
      "---\ndescription: Write docs\n---\n# Writer\n",
      "utf8",
    );

    const context = await discoverWorkspaceContext(root);
    expect(context.instructionFiles[0]).toEqual(
      expect.objectContaining({ path: "AGENTS.md", rootLevel: true, inlineContent: "Root rules\n" }),
    );
    expect(context.instructionFiles[1]).toEqual(expect.objectContaining({ path: "packages/app/CLAUDE.md", rootLevel: false }));
    expect(context.instructionFiles[1]).not.toHaveProperty("inlineContent");
    expect(context.skills).toEqual([
      expect.objectContaining({ name: "reviewer", source: "ctc", description: "Review code changes" }),
      expect.objectContaining({ name: "writer", source: "claude", description: "Write docs" }),
    ]);

    const skill = await loadWorkspaceSkill(root, "reviewer");
    expect(skill.source).toBe("ctc");
    expect(skill.content).toContain("# Reviewer");
  });
});
