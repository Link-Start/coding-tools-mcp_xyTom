import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApprovalRequest } from "../src/shared/approvals.js";
import { listTuiSessions, loadTuiSnapshot } from "../src/tui/state.js";

describe("TUI session state", () => {
  it("loads attached v1 sessions from JSONL logs", async () => {
    const home = await mkdtemp(join(tmpdir(), "ctc-tui-home-"));
    process.env.CTC_HOME = home;
    await mkdir(join(home, "logs"), { recursive: true });

    await writeSessionLog(home, "session-a", "/repo/api", "direct");
    await writeSessionLog(home, "session-b", "/repo/web", "worktree");
    await createApprovalRequest("session-b", "{\"permission\":\"network\"}", { permission: "network" });

    const sessions = await listTuiSessions();
    expect(sessions.map((session) => session.sessionId)).toEqual(expect.arrayContaining(["session-a", "session-b"]));
    expect(sessions.find((session) => session.sessionId === "session-b")?.pendingApprovalCount).toBe(1);

    const snapshot = await loadTuiSnapshot({ requestedSessionId: "session-b", initialWorkspacePath: "/repo/web" });
    expect(snapshot.sessionId).toBe("session-b");
    expect(snapshot.session?.workspacePath).toBe("/repo/web");
    expect(snapshot.pendingApprovals).toHaveLength(1);
    expect(snapshot.allPendingApprovals).toHaveLength(1);
  });
});

async function writeSessionLog(home: string, sessionId: string, workspacePath: string, defaultMode: "direct" | "worktree") {
  const sessionStarted = {
    ts: "2026-07-03T12:00:00.000Z",
    sessionId,
    type: "session_started",
    workspacePath,
    defaultMode,
    backendType: "stdio",
    backendStatus: { connected: true, reconnecting: false },
    logPath: join(home, "logs", `${sessionId}.jsonl`),
  };
  const toolCall = {
    ts: "2026-07-03T12:00:01.000Z",
    sessionId,
    type: "tool_call",
    tool: "read_file",
    argsSummary: "src/app.ts",
    resultSummary: "ok",
    durationMs: 12,
  };
  await writeFile(join(home, "logs", `${sessionId}.jsonl`), `${JSON.stringify(sessionStarted)}\n${JSON.stringify(toolCall)}\n`, "utf8");
}
