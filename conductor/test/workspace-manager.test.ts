import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { WorkspaceManager, closeWorkspaceSession, mergeWorkspaceSession, type ToolCaller } from "../src/workspace/manager.js";
import { createGitRepo } from "./git-fixtures.js";

describe("WorkspaceManager", () => {
  it("opens an isolated worktree and leaves the source tree untouched", async () => {
    const repo = await createGitRepo("ctc-workspace-repo-");
    process.env.CTC_HOME = await mkdtemp(join(tmpdir(), "ctc-home-"));
    const backend = new FakeBackend();
    const manager = new WorkspaceManager({
      backend,
      sessionId: "session-worktree",
      defaultWorkspacePath: repo,
      defaultMode: "worktree",
    });

    const opened = await manager.open({});
    expect(opened.workspace.mode).toBe("worktree");
    expect(opened.workspace.activePath).not.toBe(repo);
    expect(backend.cwd).toBe(opened.workspace.activePath);

    await writeFile(join(opened.workspace.activePath, "a.txt"), "worktree change\n", "utf8");
    await writeFile(join(opened.workspace.activePath, "new.txt"), "new file\n", "utf8");
    await expect(readFile(join(repo, "a.txt"), "utf8")).resolves.toBe("base\n");

    const blocked = await manager.close();
    expect(blocked.closed).toBe(false);
    expect(blocked.dirty).toBe(true);

    const closed = await manager.close({ force: true });
    expect(closed.closed).toBe(true);
    expect(existsSync(opened.workspace.activePath)).toBe(false);
  });

  it("rolls back a worktree when the backend cwd update fails", async () => {
    const repo = await createGitRepo("ctc-workspace-rollback-");
    process.env.CTC_HOME = await mkdtemp(join(tmpdir(), "ctc-home-"));
    const manager = new WorkspaceManager({
      backend: new FakeBackend(true),
      sessionId: "session-rollback",
      defaultWorkspacePath: repo,
      defaultMode: "worktree",
    });

    await expect(manager.open({})).rejects.toThrow(/set_default_cwd failed/);
    expect(manager.current()).toBeUndefined();
  });

  it("refuses to merge a worktree into a dirty source repository", async () => {
    const repo = await createGitRepo("ctc-workspace-dirty-merge-");
    process.env.CTC_HOME = await mkdtemp(join(tmpdir(), "ctc-home-"));
    const manager = new WorkspaceManager({
      backend: new FakeBackend(),
      sessionId: "session-dirty-merge",
      defaultWorkspacePath: repo,
      defaultMode: "worktree",
    });

    const opened = await manager.open({});
    await writeFile(join(opened.workspace.activePath, "new.txt"), "worktree change\n", "utf8");
    await writeFile(join(repo, "source-dirty.txt"), "source dirty\n", "utf8");

    await expect(mergeWorkspaceSession("session-dirty-merge")).rejects.toThrow(/target repository has uncommitted changes/);
    await manager.close({ force: true });
  });

  it("closes a recorded worktree session by id", async () => {
    const repo = await createGitRepo("ctc-workspace-close-by-id-");
    process.env.CTC_HOME = await mkdtemp(join(tmpdir(), "ctc-home-"));
    const manager = new WorkspaceManager({
      backend: new FakeBackend(),
      sessionId: "session-close-by-id",
      defaultWorkspacePath: repo,
      defaultMode: "worktree",
    });

    const opened = await manager.open({});
    await writeFile(join(opened.workspace.activePath, "new.txt"), "dirty\n", "utf8");

    const blocked = await closeWorkspaceSession("session-close-by-id");
    expect(blocked.closed).toBe(false);
    expect(blocked.dirty).toBe(true);

    const closed = await closeWorkspaceSession("session-close-by-id", { force: true });
    expect(closed.closed).toBe(true);
    expect(existsSync(opened.workspace.activePath)).toBe(false);
  });
});

class FakeBackend implements ToolCaller {
  cwd?: string;

  constructor(private readonly failSetCwd = false) {}

  callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    if (name !== "set_default_cwd") throw new Error(`Unexpected tool ${name}`);
    this.cwd = String(args.path);
    if (this.failSetCwd) {
      return Promise.resolve({ content: [{ type: "text", text: "set_default_cwd failed" }], isError: true });
    }
    return Promise.resolve({ content: [{ type: "text", text: "ok" }], isError: false });
  }
}
