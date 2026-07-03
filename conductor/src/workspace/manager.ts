import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { execa } from "execa";
import { z } from "zod";
import { discoverWorkspaceContext, loadWorkspaceSkill } from "../context/discovery.js";
import { ctcHome } from "../profiles/config.js";
import type { LoadedSkill, WorkspaceContextGuide, WorkspaceMode, WorkspaceState } from "../shared/types.js";

export interface ToolCaller {
  callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
}

export const openWorkspaceSchema = z.object({
  path: z.string().optional(),
  mode: z.enum(["direct", "worktree"]).optional(),
  base: z.string().optional(),
});

export const closeWorkspaceSchema = z.object({
  force: z.boolean().optional(),
});

export type OpenWorkspaceArgs = z.infer<typeof openWorkspaceSchema>;
export type CloseWorkspaceArgs = z.infer<typeof closeWorkspaceSchema>;

export interface OpenWorkspaceResult {
  workspace: WorkspaceState;
  context: WorkspaceContextGuide;
}

export interface CloseWorkspaceResult {
  closed: boolean;
  workspace?: WorkspaceState;
  dirty?: boolean;
  message: string;
}

export interface WorkspaceCleanResult {
  removed: string[];
  skippedDirty: string[];
  missing: string[];
}

export interface WorkspaceMergeResult {
  sessionId: string;
  applied: boolean;
  patchBytes: number;
  message: string;
}

export class WorkspaceManager {
  private readonly backend: ToolCaller;
  private readonly sessionId: string;
  private readonly defaultWorkspacePath: string;
  private readonly defaultMode: WorkspaceMode;
  private state?: WorkspaceState;

  constructor(options: {
    backend: ToolCaller;
    sessionId: string;
    defaultWorkspacePath: string;
    defaultMode: WorkspaceMode;
  }) {
    this.backend = options.backend;
    this.sessionId = options.sessionId;
    this.defaultWorkspacePath = options.defaultWorkspacePath;
    this.defaultMode = options.defaultMode;
  }

  current(): WorkspaceState | undefined {
    return this.state;
  }

  async hasDirtyWorktree(): Promise<boolean> {
    if (!this.state || this.state.mode !== "worktree") return false;
    const worktreePath = requireWorktreePath(this.state);
    return existsSync(worktreePath) ? isGitDirty(worktreePath) : false;
  }

  async open(input: OpenWorkspaceArgs): Promise<OpenWorkspaceResult> {
    if (this.state && !this.state.closedAt) {
      throw new Error(`Workspace is already open at ${this.state.activePath}`);
    }
    const mode = input.mode ?? this.defaultMode;
    const sourcePath = resolve(input.path ?? this.defaultWorkspacePath);
    const openedAt = new Date().toISOString();
    const workspace =
      mode === "direct"
        ? await this.openDirect(sourcePath, openedAt)
        : await this.openWorktree(sourcePath, input.base ?? "HEAD", openedAt);
    this.state = workspace;
    await writeSessionState(workspace);
    const context = await discoverWorkspaceContext(contextRoot(workspace));
    return {
      workspace,
      context,
    };
  }

  async loadSkill(name: string): Promise<LoadedSkill> {
    if (!this.state || this.state.closedAt) throw new Error("Open a workspace before loading a skill.");
    return loadWorkspaceSkill(contextRoot(this.state), name);
  }

  async close(input: CloseWorkspaceArgs = {}): Promise<CloseWorkspaceResult> {
    if (!this.state || this.state.closedAt) {
      return { closed: false, message: "No workspace is open in this session." };
    }

    const workspace = this.state;
    if (workspace.mode === "direct") {
      const closed = { ...workspace, closedAt: new Date().toISOString() };
      this.state = closed;
      await writeSessionState(closed);
      return { closed: true, workspace: closed, message: "Direct workspace closed." };
    }

    const worktreePath = requireWorktreePath(workspace);
    const dirty = existsSync(worktreePath) ? await isGitDirty(worktreePath) : false;
    if (dirty && !input.force) {
      return {
        closed: false,
        workspace,
        dirty: true,
        message: "Worktree has uncommitted changes. Re-run with force after reviewing or merging.",
      };
    }

    await this.setBackendCwd(workspace.sourcePath).catch(() => undefined);
    await removeWorktree(workspace, true);
    const closed = { ...workspace, closedAt: new Date().toISOString() };
    this.state = closed;
    await writeSessionState(closed);
    return { closed: true, workspace: closed, dirty, message: "Worktree workspace closed and removed." };
  }

  private async openDirect(sourcePath: string, openedAt: string): Promise<WorkspaceState> {
    await this.setBackendCwd(sourcePath);
    const repoRoot = await gitOutput(sourcePath, ["rev-parse", "--show-toplevel"]).catch(() => undefined);
    return {
      sessionId: this.sessionId,
      mode: "direct",
      sourcePath,
      activePath: sourcePath,
      repoRoot,
      openedAt,
    };
  }

  private async openWorktree(sourcePath: string, baseRef: string, openedAt: string): Promise<WorkspaceState> {
    const repoRoot = await gitOutput(sourcePath, ["rev-parse", "--show-toplevel"]);
    const baseCommit = await gitOutput(repoRoot, ["rev-parse", "--verify", `${baseRef}^{commit}`]);
    const worktreePath = join(ctcHome(), "worktrees", repoHash(repoRoot), this.sessionId);
    await mkdir(dirname(worktreePath), { recursive: true });
    await execa("git", ["-C", repoRoot, "worktree", "add", "--detach", worktreePath, baseCommit]);
    try {
      await this.setBackendCwd(worktreePath);
    } catch (error) {
      await removeWorktree({ repoRoot, worktreePath } as WorkspaceState, true).catch(() => undefined);
      throw error;
    }
    return {
      sessionId: this.sessionId,
      mode: "worktree",
      sourcePath,
      activePath: worktreePath,
      repoRoot,
      worktreePath,
      baseRef,
      baseCommit,
      openedAt,
    };
  }

  private async setBackendCwd(path: string): Promise<void> {
    const result = await this.backend.callTool("set_default_cwd", { path });
    if (result.isError) throw new Error(resultText(result) || `set_default_cwd failed for ${path}`);
  }
}

export async function listWorkspaceSessions(): Promise<WorkspaceState[]> {
  const dir = sessionsDir();
  if (!existsSync(dir)) return [];
  const names = await readdir(dir);
  const states = await Promise.all(
    names
      .filter((name) => name.endsWith(".json"))
      .map(async (name) => readSessionState(name.slice(0, -".json".length)).catch(() => undefined)),
  );
  return states.filter((state): state is WorkspaceState => Boolean(state));
}

export async function readWorkspaceSession(sessionId: string): Promise<WorkspaceState | undefined> {
  return readSessionState(sessionId).catch(() => undefined);
}

export async function cleanWorkspaceSessions(options: { force?: boolean } = {}): Promise<WorkspaceCleanResult> {
  const result: WorkspaceCleanResult = { removed: [], skippedDirty: [], missing: [] };
  for (const state of await listWorkspaceSessions()) {
    if (state.mode !== "worktree" || state.closedAt) continue;
    const worktreePath = state.worktreePath;
    if (!worktreePath || !existsSync(worktreePath)) {
      result.missing.push(state.sessionId);
      continue;
    }
    const dirty = await isGitDirty(worktreePath);
    if (dirty && !options.force) {
      result.skippedDirty.push(state.sessionId);
      continue;
    }
    await removeWorktree(state, true);
    await writeSessionState({ ...state, closedAt: new Date().toISOString() });
    result.removed.push(state.sessionId);
  }
  await pruneKnownWorktreeRepos();
  return result;
}

export async function mergeWorkspaceSession(sessionId: string): Promise<WorkspaceMergeResult> {
  const state = await readSessionState(sessionId);
  if (state.mode !== "worktree") throw new Error(`Session ${sessionId} is not a worktree workspace.`);
  const worktreePath = requireWorktreePath(state);
  const repoRoot = state.repoRoot ?? (await gitOutput(state.sourcePath, ["rev-parse", "--show-toplevel"]));
  const baseCommit = state.baseCommit ?? (await gitOutput(worktreePath, ["rev-parse", "HEAD"]));
  const snapshot = await createSnapshotCommit(worktreePath, baseCommit, "ctc merge snapshot");
  const patch = await gitOutput(worktreePath, ["diff", "--binary", baseCommit, snapshot], { trim: false });
  if (!patch.trim()) {
    return { sessionId, applied: false, patchBytes: 0, message: "No changes to merge." };
  }
  await execa("git", ["-C", repoRoot, "apply", "--3way"], { input: patch });
  return {
    sessionId,
    applied: true,
    patchBytes: Buffer.byteLength(patch),
    message: `Applied worktree patch to ${repoRoot}.`,
  };
}

async function writeSessionState(state: WorkspaceState): Promise<void> {
  const file = sessionStatePath(state.sessionId);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function readSessionState(sessionId: string): Promise<WorkspaceState> {
  return JSON.parse(await readFile(sessionStatePath(sessionId), "utf8")) as WorkspaceState;
}

function sessionStatePath(sessionId: string): string {
  return join(sessionsDir(), `${sessionId}.json`);
}

function sessionsDir(): string {
  return join(ctcHome(), "sessions");
}

async function removeWorktree(state: WorkspaceState, force: boolean): Promise<void> {
  const worktreePath = requireWorktreePath(state);
  if (state.repoRoot && existsSync(state.repoRoot)) {
    const args = ["-C", state.repoRoot, "worktree", "remove"];
    if (force) args.push("--force");
    args.push(worktreePath);
    await execa("git", args).catch(async () => {
      await rm(worktreePath, { recursive: true, force: true });
    });
  } else {
    await rm(worktreePath, { recursive: true, force: true });
  }
}

async function pruneKnownWorktreeRepos(): Promise<void> {
  const repos = new Set((await listWorkspaceSessions()).map((state) => state.repoRoot).filter(isString));
  for (const repo of repos) {
    if (existsSync(repo)) await execa("git", ["-C", repo, "worktree", "prune"]).catch(() => undefined);
  }
}

async function isGitDirty(path: string): Promise<boolean> {
  const status = await gitOutput(path, ["status", "--porcelain=v1"], { trim: false });
  return status.trim().length > 0;
}

async function createSnapshotCommit(path: string, parentCommit: string, message: string): Promise<string> {
  const indexFile = join(tmpdir(), `ctc-index-${randomUUID()}`);
  try {
    await gitOutput(path, ["read-tree", parentCommit], { env: { GIT_INDEX_FILE: indexFile } });
    await gitOutput(path, ["add", "-A"], { env: { GIT_INDEX_FILE: indexFile } });
    const tree = await gitOutput(path, ["write-tree"], { env: { GIT_INDEX_FILE: indexFile } });
    return await gitOutput(path, ["commit-tree", tree, "-p", parentCommit, "-m", message], {
      env: {
        GIT_INDEX_FILE: indexFile,
        GIT_AUTHOR_NAME: "ctc",
        GIT_AUTHOR_EMAIL: "ctc@example.invalid",
        GIT_COMMITTER_NAME: "ctc",
        GIT_COMMITTER_EMAIL: "ctc@example.invalid",
      },
    });
  } finally {
    await rm(indexFile, { force: true });
  }
}

async function gitOutput(
  cwd: string,
  args: string[],
  options: { trim?: boolean; env?: Record<string, string> } = {},
): Promise<string> {
  const { stdout } = await execa("git", ["-C", cwd, ...args], {
    env: options.env,
    maxBuffer: 10 * 1024 * 1024,
  });
  return options.trim === false ? stdout : stdout.trim();
}

function requireWorktreePath(state: WorkspaceState): string {
  if (!state.worktreePath) throw new Error(`Session ${state.sessionId} has no worktree path.`);
  return state.worktreePath;
}

function contextRoot(state: WorkspaceState): string {
  if (state.mode === "worktree") return requireWorktreePath(state);
  return state.repoRoot ?? state.activePath;
}

function repoHash(repoPath: string): string {
  return createHash("sha256").update(resolve(repoPath)).digest("hex").slice(0, 16);
}

function resultText(result: CallToolResult): string {
  return result.content
    .map((item) => (item.type === "text" ? item.text : ""))
    .filter(Boolean)
    .join("\n");
}

function isString(value: string | undefined): value is string {
  return typeof value === "string";
}
