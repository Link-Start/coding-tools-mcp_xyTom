import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  cleanWorkspaceSessions,
  listWorkspaceSessions,
  mergeWorkspaceSession,
} from "../workspace/manager.js";

export async function printWorkspaceList(): Promise<void> {
  const sessions = await listWorkspaceSessions();
  if (!sessions.length) {
    process.stdout.write("No ctc workspaces recorded.\n");
    return;
  }
  for (const state of sessions) {
    const status = state.closedAt ? "closed" : "open";
    const active = state.worktreePath ?? state.activePath;
    process.stdout.write(`${state.sessionId}\t${status}\t${state.mode}\t${active}\n`);
  }
}

export async function cleanWorkspacesCli(options: { force?: boolean; yes?: boolean }): Promise<void> {
  if (!options.force && !options.yes) {
    const ok = await confirm("Clean non-dirty orphaned ctc worktrees? Dirty worktrees will be skipped. [y/N] ");
    if (!ok) {
      process.stdout.write("No worktrees cleaned.\n");
      return;
    }
  }
  const result = await cleanWorkspaceSessions({ force: options.force });
  process.stdout.write(
    `Removed ${String(result.removed.length)}; skipped dirty ${String(result.skippedDirty.length)}; missing ${String(result.missing.length)}.\n`,
  );
  if (result.skippedDirty.length) process.stdout.write(`Dirty sessions: ${result.skippedDirty.join(", ")}\n`);
}

export async function mergeWorkspaceCli(sessionId: string): Promise<void> {
  const result = await mergeWorkspaceSession(sessionId);
  process.stdout.write(`${result.message}\n`);
  if (result.applied) process.stdout.write(`Patch bytes: ${String(result.patchBytes)}\n`);
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input, output });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}
