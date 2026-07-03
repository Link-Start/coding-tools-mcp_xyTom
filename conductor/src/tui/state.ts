import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { readBatonBundle, type BatonBundle } from "../baton/protocol.js";
import { ctcHome } from "../profiles/config.js";
import { listPendingApprovals, type PermissionApprovalRequest } from "../shared/approvals.js";
import type {
  ConductorEvent,
  ReviewCheckpointEvent,
  SessionStartedEvent,
  ToolCallEvent,
  WorkspaceState,
} from "../shared/types.js";
import { readWorkspaceSession } from "../workspace/manager.js";

export interface TuiSnapshot {
  sessionId?: string;
  logPath?: string;
  events: ConductorEvent[];
  toolCalls: ToolCallEvent[];
  checkpoints: ReviewCheckpointEvent[];
  session?: SessionStartedEvent;
  workspace?: WorkspaceState;
  baton?: BatonBundle;
  pendingApprovals: PermissionApprovalRequest[];
}

export async function loadTuiSnapshot(requestedSessionId?: string): Promise<TuiSnapshot> {
  const logPath = await findSessionLog(requestedSessionId);
  if (!logPath) return { events: [], toolCalls: [], checkpoints: [], pendingApprovals: [] };
  const sessionId = sessionIdFromLogPath(logPath);
  const events = await readEventLog(logPath);
  const session = lastOfType(events, "session_started");
  const workspace = sessionId ? await readWorkspaceSession(sessionId) : undefined;
  const root = workspace?.activePath ?? session?.workspacePath;
  const baton = root ? await readBatonBundle(root).catch(() => undefined) : undefined;
  const pendingApprovals = sessionId ? await listPendingApprovals(sessionId).catch(() => []) : [];
  return {
    sessionId,
    logPath,
    events,
    toolCalls: events.filter((event): event is ToolCallEvent => event.type === "tool_call"),
    checkpoints: events.filter((event): event is ReviewCheckpointEvent => event.type === "review_checkpoint"),
    session,
    workspace,
    baton,
    pendingApprovals,
  };
}

async function findSessionLog(sessionId?: string): Promise<string | undefined> {
  const dir = join(ctcHome(), "logs");
  if (!existsSync(dir)) return undefined;
  if (sessionId) {
    const path = join(dir, `${sessionId}.jsonl`);
    return existsSync(path) ? path : undefined;
  }
  const entries = await Promise.all(
    (await readdir(dir))
      .filter((name) => name.endsWith(".jsonl"))
      .map(async (name) => ({ path: join(dir, name), mtimeMs: (await stat(join(dir, name))).mtimeMs })),
  );
  return entries.sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.path;
}

async function readEventLog(path: string): Promise<ConductorEvent[]> {
  const text = await readFile(path, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter(Boolean)
    .map(parseEvent)
    .filter((event): event is ConductorEvent => Boolean(event));
}

function parseEvent(line: string): ConductorEvent | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    if (!isObject(parsed)) return undefined;
    const type = parsed.type;
    if (
      type === "tool_call" ||
      type === "review_checkpoint" ||
      type === "session_started" ||
      type === "permission_request"
    ) {
      return parsed as unknown as ConductorEvent;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function lastOfType<T extends ConductorEvent["type"]>(
  events: ConductorEvent[],
  type: T,
): Extract<ConductorEvent, { type: T }> | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === type) return event as Extract<ConductorEvent, { type: T }>;
  }
  return undefined;
}

function sessionIdFromLogPath(path: string): string {
  return basename(path, ".jsonl");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}
