import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  ctcHome,
  defaultBackendForPath,
  readProfileForPath,
  resolveRuntimeOptions,
  writeProfileForPath,
} from "../profiles/config.js";
import { ConductorHttpServer } from "../server/http.js";
import { ConductorRuntime } from "../server/mcp.js";
import { MemoryApprovalBroker, respondToApproval as respondToFileApproval } from "../shared/approvals.js";
import { JsonlEventLog } from "../shared/logging.js";
import { summarizeResult } from "../shared/summarize.js";
import type { BackendStatus, WorkspaceMode, WorkspaceProfile, WorkspaceState } from "../shared/types.js";
import {
  CompositeSessionEventSink,
  JsonlSessionEventSink,
  SessionEventBus,
  type SessionEventSink,
} from "../sessions/events.js";
import { TunnelManager, type TunnelState } from "../tunnel/manager.js";
import {
  closeWorkspaceSession,
  listWorkspaceSessions,
  mergeWorkspaceSession,
  readWorkspaceSession,
  type CloseWorkspaceResult,
  type WorkspaceMergeResult,
} from "../workspace/manager.js";

export interface CreateTuiSessionOptions {
  path?: string;
  mode?: WorkspaceMode;
  resume?: string;
}

export interface CreateTuiSessionResult {
  sessionId: string;
  workspace: WorkspaceState;
  message: string;
  httpUrl?: string;
}

export interface TuiConfigResult {
  text: string;
  changed: boolean;
}

export interface TuiTunnelResult {
  state: TunnelState;
  message: string;
}

interface HostedSession {
  runtime: ConductorRuntime;
  events: SessionEventSink;
  httpUrl?: string;
}

interface OpenWorkspaceRuntimeResult {
  workspace: WorkspaceState;
}

export class TuiSessionController {
  private readonly sessions = new Map<string, HostedSession>();
  private readonly eventBus = new SessionEventBus();
  private readonly approvals = new MemoryApprovalBroker();
  private readonly tunnel = new TunnelManager();
  private http?: ConductorHttpServer;

  async create(options: CreateTuiSessionOptions): Promise<CreateTuiSessionResult> {
    if (options.resume) return this.resume(options.resume);

    const runtimeOptions = await resolveRuntimeOptions({ path: options.path, conciseLogs: false });
    const events = new CompositeSessionEventSink([
      new JsonlSessionEventSink(new JsonlEventLog(runtimeOptions.logPath, false)),
      this.eventBus,
    ]);
    const runtime = new ConductorRuntime(runtimeOptions, { owner: "tui", events, approvals: this.approvals });
    try {
      await runtime.start();
      const opened = requireStructured<OpenWorkspaceRuntimeResult>(
        await runtime.callTool("open_workspace", { path: runtimeOptions.workspacePath, mode: options.mode }),
      );
      const httpUrl = await this.registerHttpSession(runtimeOptions.sessionId, runtime, runtimeOptions.workspacePath);
      this.sessions.set(runtimeOptions.sessionId, { runtime, events, httpUrl });
      return {
        sessionId: runtimeOptions.sessionId,
        workspace: opened.workspace,
        httpUrl,
        message: `Opened ${opened.workspace.mode} workspace ${opened.workspace.activePath}. MCP: ${httpUrl}`,
      };
    } catch (error) {
      await runtime.stop().catch(() => undefined);
      throw error;
    }
  }

  async close(sessionId: string, options: { force?: boolean } = {}): Promise<CloseWorkspaceResult> {
    const hosted = this.sessions.get(sessionId);
    const started = performance.now();
    if (hosted) {
      const result = requireStructured<CloseWorkspaceResult>(
        await hosted.runtime.callTool("close_workspace", { force: options.force }),
      );
      if (result.closed) {
        await this.http?.unregisterSession(sessionId).catch(() => undefined);
        await hosted.runtime.stop().catch(() => undefined);
        this.sessions.delete(sessionId);
      }
      return result;
    }

    const result = await closeWorkspaceSession(sessionId, { force: options.force });
    await appendToolEvent(
      jsonlSinkForSession(sessionId),
      sessionId,
      "close_workspace",
      started,
      result,
      result.closed ? undefined : result.message,
    );
    return result;
  }

  async merge(sessionId: string): Promise<WorkspaceMergeResult> {
    const hosted = this.sessions.get(sessionId);
    const events = hosted?.events ?? jsonlSinkForSession(sessionId);
    const started = performance.now();
    try {
      const result = await mergeWorkspaceSession(sessionId);
      await appendToolEvent(events, sessionId, "merge_workspace", started, result, result.applied ? undefined : result.message);
      return result;
    } catch (error) {
      await appendToolEvent(events, sessionId, "merge_workspace", started, undefined, error).catch(() => undefined);
      throw error;
    }
  }

  async respondToApproval(sessionId: string, requestId: string, approved: boolean): Promise<void> {
    if (this.sessions.has(sessionId)) await this.approvals.respond(sessionId, requestId, approved);
    else await respondToFileApproval(sessionId, requestId, approved);
  }

  async startTunnel(): Promise<TuiTunnelResult> {
    const http = await this.ensureHttpServer();
    if (!http.origin) throw new Error("HTTP MCP server is not listening.");
    const state = await this.tunnel.start(http.origin);
    http.setBearerToken(state.token);
    const sampleSession = this.sessions.keys().next().value as string | undefined;
    const route = `${state.publicUrl}/mcp/${sampleSession ?? "<session-id>"}`;
    return {
      state,
      message: `Tunnel ready: ${route} with Authorization: Bearer ${state.token ?? "<token>"}`,
    };
  }

  async stopTunnel(): Promise<TuiTunnelResult> {
    const state = await this.tunnel.stop();
    this.http?.setBearerToken(undefined);
    return { state, message: "Tunnel stopped." };
  }

  tunnelStatus(): TunnelState {
    return this.tunnel.status();
  }

  onEvent(listener: () => void): () => void {
    this.eventBus.on("event", listener);
    return () => {
      this.eventBus.off("event", listener);
    };
  }

  async configure(path: string | undefined, args: string[]): Promise<TuiConfigResult> {
    const targetPath = path ?? process.cwd();
    const existing = await readProfileForPath(targetPath).catch(() => undefined);
    const profile: WorkspaceProfile = existing ?? {
      repoPath: targetPath,
      backend: defaultBackendForPath(targetPath),
      defaultMode: "worktree",
      permissionMode: "safe",
      tunnel: { provider: "none" },
    };

    if (!args.length) return { text: formatProfile(profile), changed: false };
    const [field, value] = args;
    if (field === "mode") {
      if (value !== "direct" && value !== "worktree") throw new Error("/config mode requires direct or worktree.");
      profile.defaultMode = value;
    } else if (field === "permission") {
      if (value !== "safe" && value !== "trusted") throw new Error("/config permission requires safe or trusted.");
      profile.permissionMode = value;
    } else if (field === "tunnel") {
      if (value !== "none" && value !== "cloudflared") throw new Error("/config tunnel requires none or cloudflared.");
      profile.tunnel = { ...(profile.tunnel ?? {}), provider: value };
    } else {
      throw new Error("Usage: /config [mode direct|worktree | permission safe|trusted | tunnel none|cloudflared]");
    }
    await writeProfileForPath(targetPath, profile);
    return { text: formatProfile(profile), changed: true };
  }

  async closeClients(): Promise<void> {
    await this.stopTunnel().catch(() => undefined);
    await this.http?.close().catch(() => undefined);
    await Promise.all([...this.sessions.values()].map((session) => session.runtime.stop().catch(() => undefined)));
    this.sessions.clear();
  }

  private async resume(resume: string): Promise<CreateTuiSessionResult> {
    const state = await findWorkspaceForResume(resume);
    if (!state) throw new Error(`No recorded workspace matches ${resume}.`);
    await ensureSessionLog(state);
    return {
      sessionId: state.sessionId,
      workspace: state,
      message: `Resumed recorded workspace ${state.activePath}. Run /new to create a live HTTP session for model clients.`,
    };
  }

  private async registerHttpSession(sessionId: string, runtime: ConductorRuntime, workspacePath: string): Promise<string> {
    const http = await this.ensureHttpServer(workspacePath);
    const registered = await http.registerSession(sessionId, runtime.createServer());
    return registered.url;
  }

  private async ensureHttpServer(workspacePath?: string): Promise<ConductorHttpServer> {
    if (!this.http) this.http = new ConductorHttpServer();
    if (this.http.origin) return this.http;
    const profile = workspacePath ? await readProfileForPath(workspacePath).catch(() => undefined) : undefined;
    const origin = await this.http.listen(profile?.httpPort);
    if (workspacePath && profile && !profile.httpPort) {
      const port = Number(new URL(origin).port);
      if (Number.isInteger(port)) await writeProfileForPath(workspacePath, { ...profile, httpPort: port });
    }
    return this.http;
  }
}

async function appendToolEvent(
  events: SessionEventSink,
  sessionId: string,
  tool: string,
  started: number,
  result: object | undefined,
  error: unknown,
): Promise<void> {
  await events.append({
    ts: new Date().toISOString(),
    sessionId,
    type: "tool_call",
    tool,
    argsSummary: "TUI command",
    resultSummary: result ? summarizeObject(result) : undefined,
    durationMs: Math.round(performance.now() - started),
    error: error ? errorMessage(error) : undefined,
  });
}

async function findWorkspaceForResume(resume: string): Promise<WorkspaceState | undefined> {
  const exact = await readWorkspaceSession(resume);
  if (exact && !exact.closedAt) return exact;
  const resolved = resolve(resume);
  return (await listWorkspaceSessions()).find(
    (state) => !state.closedAt && (state.worktreePath === resolved || state.activePath === resolved || basename(state.activePath) === resume),
  );
}

async function ensureSessionLog(state: WorkspaceState): Promise<void> {
  const path = sessionLogPath(state.sessionId);
  if (existsSync(path)) return;
  await mkdir(join(ctcHome(), "logs"), { recursive: true });
  const eventLog = new JsonlEventLog(path, false);
  const status: BackendStatus = { connected: false, reconnecting: false };
  await eventLog.append({
    ts: new Date().toISOString(),
    sessionId: state.sessionId,
    type: "session_started",
    owner: "tui",
    workspacePath: state.sourcePath,
    defaultMode: state.mode,
    backendType: "stdio",
    backendStatus: status,
    logPath: path,
  });
}

function sessionLogPath(sessionId: string): string {
  return join(ctcHome(), "logs", `${sessionId}.jsonl`);
}

function jsonlSinkForSession(sessionId: string): SessionEventSink {
  return new JsonlSessionEventSink(new JsonlEventLog(sessionLogPath(sessionId), false));
}

function summarizeObject(value: object): string {
  return summarizeResult({ content: [{ type: "text", text: JSON.stringify(value) }], isError: false });
}

function requireStructured<T extends object>(result: CallToolResult): T {
  if (result.isError) throw new Error(resultText(result) || "MCP tool call failed.");
  if (result.structuredContent) return result.structuredContent as T;
  const text = resultText(result);
  if (!text) throw new Error("MCP tool call returned no structured content.");
  return JSON.parse(text) as T;
}

function resultText(result: CallToolResult): string | undefined {
  const block = result.content.find((item) => item.type === "text");
  return block?.type === "text" ? block.text : undefined;
}

function formatProfile(profile: WorkspaceProfile): string {
  const allow = profile.toolPolicy?.allow?.join(", ") || "<any>";
  const deny = profile.toolPolicy?.deny?.join(", ") || "<none>";
  return [
    `repo: ${profile.repoPath}`,
    `backend: ${profile.backend.type}`,
    `defaultMode: ${profile.defaultMode ?? "direct"}`,
    `permissionMode: ${profile.permissionMode ?? "safe"}`,
    `httpPort: ${profile.httpPort ? String(profile.httpPort) : "<auto>"}`,
    `tunnel: ${profile.tunnel?.provider ?? "none"}`,
    `allow: ${allow}`,
    `deny: ${deny}`,
  ].join("\n");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
