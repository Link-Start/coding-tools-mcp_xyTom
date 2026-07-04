import { existsSync } from "node:fs";
import { open, readFile, readdir, stat } from "node:fs/promises";
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
  initialWorkspacePath?: string;
  sessions: TuiSessionSummary[];
  events: ConductorEvent[];
  toolCalls: ToolCallEvent[];
  checkpoints: ReviewCheckpointEvent[];
  session?: SessionStartedEvent;
  workspace?: WorkspaceState;
  baton?: BatonBundle;
  pendingApprovals: PermissionApprovalRequest[];
  allPendingApprovals: PermissionApprovalRequest[];
}

export interface TuiSessionSummary {
  sessionId: string;
  label: string;
  logPath: string;
  mtimeMs: number;
  owner: "stdio" | "tui";
  mode?: string;
  workspacePath?: string;
  backendConnected?: boolean;
  pendingApprovalCount: number;
  attached: boolean;
}

export interface LoadTuiSnapshotOptions {
  requestedSessionId?: string;
  initialWorkspacePath?: string;
}

export async function loadTuiSnapshot(options: LoadTuiSnapshotOptions = {}): Promise<TuiSnapshot> {
  const sessions = await listTuiSessions();
  const requestedSessionId = options.requestedSessionId;
  const logPath = findSessionLog(sessions, requestedSessionId);
  const allPendingApprovals = await listAllPendingApprovals(sessions);
  if (!logPath) {
    return {
      initialWorkspacePath: options.initialWorkspacePath,
      sessions,
      events: [],
      toolCalls: [],
      checkpoints: [],
      pendingApprovals: [],
      allPendingApprovals,
    };
  }
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
    initialWorkspacePath: options.initialWorkspacePath,
    sessions,
    events,
    toolCalls: events.filter((event): event is ToolCallEvent => event.type === "tool_call"),
    checkpoints: events.filter((event): event is ReviewCheckpointEvent => event.type === "review_checkpoint"),
    session,
    workspace,
    baton,
    pendingApprovals,
    allPendingApprovals,
  };
}

export async function listTuiSessions(): Promise<TuiSessionSummary[]> {
  const dir = join(ctcHome(), "logs");
  if (!existsSync(dir)) return [];
  const entries = await Promise.all(
    (await readdir(dir))
      .filter((name) => name.endsWith(".jsonl"))
      .map(async (name) => summarizeSessionLog(join(dir, name), (await stat(join(dir, name))).mtimeMs)),
  );
  return entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function findSessionLog(sessions: TuiSessionSummary[], sessionId?: string): string | undefined {
  if (sessionId) return sessions.find((session) => session.sessionId === sessionId)?.logPath;
  return sessions[0]?.logPath;
}

async function summarizeSessionLog(logPath: string, mtimeMs: number): Promise<TuiSessionSummary> {
  const sessionId = sessionIdFromLogPath(logPath);
  const events = await readEventLog(logPath);
  const session = lastOfType(events, "session_started");
  const workspace = await readWorkspaceSession(sessionId).catch(() => undefined);
  const workspacePath = workspace?.activePath ?? session?.workspacePath;
  const pendingApprovalCount = await listPendingApprovals(sessionId).then((requests) => requests.length, () => 0);
  return {
    sessionId,
    label: labelForSession(sessionId, workspacePath),
    logPath,
    mtimeMs,
    mode: workspace?.mode ?? session?.defaultMode,
    workspacePath,
    backendConnected: session?.backendStatus.connected,
    pendingApprovalCount,
    owner: session?.owner ?? "stdio",
    attached: session?.owner !== "tui",
  };
}

async function listAllPendingApprovals(sessions: TuiSessionSummary[]): Promise<PermissionApprovalRequest[]> {
  const pending = await Promise.all(sessions.map((session) => listPendingApprovals(session.sessionId).catch(() => [])));
  return pending.flat().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

interface LogCacheEntry {
  mtimeMs: number;
  size: number;
  consumedBytes: number;
  events: ConductorEvent[];
}

const logCache = new Map<string, LogCacheEntry>();

async function readEventLog(path: string): Promise<ConductorEvent[]> {
  const stats = await stat(path).catch(() => undefined);
  if (!stats) return [];
  const cached = logCache.get(path);
  if (cached && cached.size === stats.size && cached.mtimeMs === stats.mtimeMs) return cached.events;
  if (cached && stats.size >= cached.consumedBytes) {
    const tail = await readFileSlice(path, cached.consumedBytes).catch(() => undefined);
    if (tail !== undefined) {
      const { events, consumed } = parseCompleteLines(tail);
      const entry: LogCacheEntry = {
        mtimeMs: stats.mtimeMs,
        size: stats.size,
        consumedBytes: cached.consumedBytes + consumed,
        events: events.length ? [...cached.events, ...events] : cached.events,
      };
      logCache.set(path, entry);
      return entry.events;
    }
  }
  const text = await readFile(path, "utf8").catch(() => "");
  const { events, consumed } = parseCompleteLines(text);
  logCache.set(path, { mtimeMs: stats.mtimeMs, size: stats.size, consumedBytes: consumed, events });
  return events;
}

function parseCompleteLines(text: string): { events: ConductorEvent[]; consumed: number } {
  const lastNewline = text.lastIndexOf("\n");
  const complete = lastNewline === -1 ? "" : text.slice(0, lastNewline + 1);
  const events = complete
    .split("\n")
    .filter(Boolean)
    .map(parseEvent)
    .filter((event): event is ConductorEvent => Boolean(event));
  let consumed = Buffer.byteLength(complete, "utf8");
  const remainder = lastNewline === -1 ? text : text.slice(lastNewline + 1);
  if (remainder) {
    const trailing = parseEvent(remainder);
    if (trailing) {
      events.push(trailing);
      consumed += Buffer.byteLength(remainder, "utf8");
    }
  }
  return { events, consumed };
}

async function readFileSlice(path: string, start: number): Promise<string> {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    const length = Math.max(0, size - start);
    if (!length) return "";
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
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

function labelForSession(sessionId: string, workspacePath?: string): string {
  if (workspacePath) return basename(workspacePath) || workspacePath;
  return sessionId.replace(/^ctc-/, "").slice(-12);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}
