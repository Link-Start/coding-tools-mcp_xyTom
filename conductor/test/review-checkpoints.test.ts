import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { ReviewManager, type ReviewToolCaller } from "../src/review/checkpoints.js";
import { createGitRepo, git } from "./git-fixtures.js";

describe("ReviewManager", () => {
  it("shows only incremental changes since the last checkpoint", async () => {
    const repo = await createGitRepo("ctc-review-repo-");
    const review = new ReviewManager({ backend: new ExecBackend(), sessionId: "review-incremental" });
    await review.initializeBaseline(repo);

    await writeFile(join(repo, "a.txt"), "base\nfirst change\n", "utf8");
    await writeFile(join(repo, "new.txt"), "new file\n", "utf8");

    const first = await review.showChanges({});
    expect(first.stat).toContain("a.txt");
    expect(first.stat).toContain("new.txt");
    expect(first.diff).toContain("+first change");
    expect(first.diff).toContain("new file mode");

    await writeFile(join(repo, "later.txt"), "later\n", "utf8");
    const second = await review.showChanges({});
    expect(second.stat).toContain("later.txt");
    expect(second.stat).not.toContain("a.txt");
    expect(second.diff).toContain("later.txt");
    expect(second.diff).not.toContain("first change");
  });

  it("does not disturb a user's staged index", async () => {
    const repo = await createGitRepo("ctc-review-index-");
    await writeFile(join(repo, "a.txt"), "staged change\n", "utf8");
    await git(repo, ["add", "a.txt"]);
    const before = await git(repo, ["diff", "--cached", "--name-only"]);

    const review = new ReviewManager({ backend: new ExecBackend(), sessionId: "review-index" });
    await review.initializeBaseline(repo);
    await writeFile(join(repo, "b.txt"), "unstaged new file\n", "utf8");
    await review.showChanges({ since: "workspace_open" });

    const after = await git(repo, ["diff", "--cached", "--name-only"]);
    expect(after).toBe(before);
    expect(after).toBe("a.txt");
  });
});

class ExecBackend implements ReviewToolCaller {
  commands: string[] = [];

  async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    if (name !== "exec_command") throw new Error(`Unexpected tool ${name}`);
    const command = String(args.cmd);
    if (/\$\(|\$\{|`|\n|\|\||\btrap\b|\bset -e\b/.test(command)) {
      throw new Error(`Unsafe shell feature used by test command: ${command}`);
    }
    this.commands.push(command);
    const workdir = String(args.workdir);
    const envArg = args.env;
    const env = envArg && typeof envArg === "object" && !Array.isArray(envArg) ? (envArg as Record<string, string>) : undefined;
    const result = await execa("bash", ["-lc", command], { cwd: workdir, env, reject: false });
    return {
      content: [{ type: "text", text: result.stdout }],
      structuredContent: {
        stdout: result.stdout,
        stderr: result.stderr,
        exit_code: result.exitCode,
      },
      isError: false,
    };
  }
}
