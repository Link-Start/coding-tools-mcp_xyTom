import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

export type WorkspaceMode = "direct" | "worktree";

export type BackendConfig =
  | {
      type: "stdio";
      command: string[];
    }
  | {
      type: "http";
      url: string;
      tokenRef?: string;
    };

export interface ToolPolicy {
  allow?: string[];
  deny?: string[];
}

export interface WorkspaceProfile {
  repoPath: string;
  backend: BackendConfig;
  defaultMode?: WorkspaceMode;
  permissionMode?: "safe" | "trusted";
  httpPort?: number;
  toolPolicy?: ToolPolicy;
  tunnel?: {
    provider: "cloudflared" | "none";
    hostname?: string;
    enabled?: boolean;
  };
  adapters?: string[];
}

export interface RuntimeOptions {
  sessionId: string;
  workspacePath: string;
  defaultMode: WorkspaceMode;
  backend: BackendConfig;
  toolPolicy: ToolPolicy;
  adapters: string[];
  logPath: string;
  conciseLogs: boolean;
}

export interface WorkspaceState {
  sessionId: string;
  mode: WorkspaceMode;
  sourcePath: string;
  activePath: string;
  repoRoot?: string;
  worktreePath?: string;
  baseRef?: string;
  baseCommit?: string;
  openedAt: string;
  closedAt?: string;
}

export interface InstructionFileSummary {
  path: string;
  bytes: number;
  rootLevel: boolean;
  inlineContent?: string;
  truncated?: boolean;
}

export interface SkillSummary {
  name: string;
  path: string;
  source: "ctc" | "claude";
  description?: string;
}

export interface WorkspaceContextGuide {
  rootPath: string;
  instructionFiles: InstructionFileSummary[];
  skills: SkillSummary[];
}

export interface LoadedSkill extends SkillSummary {
  content: string;
}

export interface ToolCallEvent {
  ts: string;
  sessionId: string;
  type: "tool_call";
  tool: string;
  argsSummary: string;
  resultSummary?: string;
  durationMs: number;
  error?: string;
}

export interface ReviewCheckpointEvent {
  ts: string;
  sessionId: string;
  type: "review_checkpoint";
  since: "last_shown" | "workspace_open" | "head";
  base: string;
  snapshot: string;
  statSummary: string;
  diff?: string;
  truncated: boolean;
}

export interface SessionStartedEvent {
  ts: string;
  sessionId: string;
  type: "session_started";
  owner?: "stdio" | "tui";
  workspacePath: string;
  defaultMode: WorkspaceMode;
  backendType: BackendConfig["type"];
  backendStatus: BackendStatus;
  logPath: string;
}

export interface PermissionRequestEvent {
  ts: string;
  sessionId: string;
  type: "permission_request";
  requestId: string;
  state: "pending" | "approved" | "denied" | "timeout";
  argsSummary: string;
}

export type ConductorEvent = ToolCallEvent | ReviewCheckpointEvent | SessionStartedEvent | PermissionRequestEvent;

export interface BackendStatus {
  connected: boolean;
  reconnecting: boolean;
  lastError?: string;
}

export type CachedTool = Tool;
export type ProxiedToolResult = CallToolResult;
