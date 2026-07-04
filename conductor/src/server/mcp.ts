import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type ServerCapabilities,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  decorateToolsForChatGpt,
  isChatGptAdapterEnabled,
  registerChatGptAdapter,
} from "../adapters/chatgpt/widgets.js";
import {
  BatonManager,
  batonUpdateStatusSchema,
  batonWritePlanSchema,
  batonWriteReportSchema,
} from "../baton/protocol.js";
import { BackendClient, BackendDisconnectedError } from "../proxy/client.js";
import { ReviewManager, showChangesSchema } from "../review/checkpoints.js";
import { FileApprovalBroker, type ApprovalBroker } from "../shared/approvals.js";
import { JsonlEventLog } from "../shared/logging.js";
import { summarizeArgs, summarizeResult } from "../shared/summarize.js";
import type { RuntimeOptions, ToolPolicy } from "../shared/types.js";
import { JsonlSessionEventSink, type SessionEventSink } from "../sessions/events.js";
import { closeWorkspaceSchema, openWorkspaceSchema, WorkspaceManager } from "../workspace/manager.js";

export async function startConductorServer(options: RuntimeOptions): Promise<void> {
  const runtime = new ConductorRuntime(options);
  await runtime.start();
  const server = runtime.createServer();
  const transport = new StdioServerTransport();
  process.stderr.write(
    `[ctc] session ${options.sessionId} workspace=${options.workspacePath} backend=${options.backend.type} log=${options.logPath}\n`,
  );
  await server.connect(transport);
}

export interface ConductorRuntimeHooks {
  owner?: "stdio" | "tui";
  events?: SessionEventSink;
  approvals?: ApprovalBroker;
}

export class ConductorRuntime {
  private readonly backend: BackendClient;
  private readonly events: SessionEventSink;
  private readonly approvals: ApprovalBroker;
  private readonly toolPolicy: ToolPolicy;
  private readonly sessionId: string;
  private readonly workspacePath: string;
  private readonly defaultMode: RuntimeOptions["defaultMode"];
  private readonly backendType: RuntimeOptions["backend"]["type"];
  private readonly owner: "stdio" | "tui";
  private readonly workspace: WorkspaceManager;
  private readonly review: ReviewManager;
  private readonly baton: BatonManager;
  private readonly chatGptAdapterEnabled: boolean;

  constructor(options: RuntimeOptions, hooks: ConductorRuntimeHooks = {}) {
    this.backend = new BackendClient(options.backend);
    this.events = hooks.events ?? new JsonlSessionEventSink(new JsonlEventLog(options.logPath, options.conciseLogs));
    this.approvals = hooks.approvals ?? new FileApprovalBroker();
    this.toolPolicy = options.toolPolicy;
    this.sessionId = options.sessionId;
    this.workspacePath = options.workspacePath;
    this.defaultMode = options.defaultMode;
    this.backendType = options.backend.type;
    this.owner = hooks.owner ?? "stdio";
    this.chatGptAdapterEnabled = isChatGptAdapterEnabled(options.adapters);
    this.workspace = new WorkspaceManager({
      backend: this.backend,
      sessionId: options.sessionId,
      defaultWorkspacePath: options.workspacePath,
      defaultMode: options.defaultMode,
    });
    this.review = new ReviewManager({ backend: this.backend, sessionId: options.sessionId });
    this.baton = new BatonManager(() => this.workspace.current()?.activePath ?? this.workspacePath);
  }

  async start(): Promise<void> {
    await this.backend.start();
    await this.events.append({
      ts: new Date().toISOString(),
      sessionId: this.sessionId,
      type: "session_started",
      owner: this.owner,
      workspacePath: this.workspacePath,
      defaultMode: this.defaultMode,
      backendType: this.backendType,
      backendStatus: this.backend.status(),
      logPath: this.events.path ?? "",
    });
  }

  async stop(): Promise<void> {
    await this.backend.close();
  }

  backendStatus() {
    return this.backend.status();
  }

  id(): string {
    return this.sessionId;
  }

  createServer(): Server {
    const capabilities: ServerCapabilities = {
      tools: { listChanged: false },
      ...(this.chatGptAdapterEnabled ? { resources: { listChanged: false } } : {}),
    };
    const server = new Server(
      { name: "coding-tools-conductor", version: "0.1.0" },
      {
        capabilities,
        instructions:
          "Coding Tools Conductor transparently proxies coding-tools-mcp tools and records each call for review and TUI attachment.",
      },
    );

    if (this.chatGptAdapterEnabled) registerChatGptAdapter(server);

    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: this.decorateTools([
        ...conductorTools,
        ...this.backend
          .tools()
          .filter((tool) => isToolAllowed(tool.name, this.toolPolicy))
          .filter((tool) => !conductorToolNames.has(tool.name)),
      ]),
    }));

    server.setRequestHandler(CallToolRequestSchema, (request): Promise<CallToolResult> => {
      return this.callTool(request.params.name, request.params.arguments ?? {});
    });

    return server;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const started = performance.now();
    if (!conductorToolNames.has(name) && !isToolAllowed(name, this.toolPolicy)) {
      const result = errorResult(`Tool ${name} is disabled by this workspace profile.`);
      await this.recordToolCall(name, args, started, result, "tool disabled by policy");
      return result;
    }

    try {
      const result = conductorToolNames.has(name)
        ? await this.callConductorTool(name, args)
        : name === "request_permissions"
          ? await this.callPermissionRequest(args)
        : await this.backend.callTool(name, args);
      await this.recordToolCall(name, args, started, result);
      return result;
    } catch (error) {
      const message = error instanceof BackendDisconnectedError ? error.message : errorMessage(error);
      const result = errorResult(message);
      await this.recordToolCall(name, args, started, result, message);
      return result;
    }
  }

  private decorateTools(tools: readonly Tool[]): Tool[] {
    return this.chatGptAdapterEnabled ? decorateToolsForChatGpt(tools) : [...tools];
  }

  private async callConductorTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    if (name === "open_workspace") {
      let opened: Awaited<ReturnType<WorkspaceManager["open"]>> | undefined;
      try {
        opened = await this.workspace.open(openWorkspaceSchema.parse(args));
        const review = await this.review.initializeBaseline(opened.workspace.activePath);
        return jsonResult({ ...opened, review });
      } catch (error) {
        if (opened?.workspace.mode === "worktree") await this.workspace.close({ force: true }).catch(() => undefined);
        throw error;
      }
    }

    if (name === "close_workspace") {
      const parsed = closeWorkspaceSchema.parse(args);
      const current = this.workspace.current();
      const dirty = await this.workspace.hasDirtyWorktree();
      if (current && (current.mode === "direct" || parsed.force || !dirty)) await this.review.clearRefs();
      return jsonResult(await this.workspace.close(parsed));
    }

    if (name === "load_skill") {
      const parsed = loadSkillSchema.parse(args);
      return jsonResult(await this.workspace.loadSkill(parsed.name));
    }

    if (name === "show_changes") {
      const result = await this.review.showChanges(showChangesSchema.parse(args));
      await this.events.append({
        ts: new Date().toISOString(),
        sessionId: this.sessionId,
        type: "review_checkpoint",
        since: result.since,
        base: result.base,
        snapshot: result.snapshot,
        statSummary: result.stat,
        diff: result.diff,
        truncated: result.truncated,
      });
      return jsonResult(result);
    }

    if (name === "baton_write_plan") {
      return jsonResult(await this.baton.writePlan(batonWritePlanSchema.parse(args)));
    }

    if (name === "baton_read_plan") {
      return jsonResult(await this.baton.readPlan());
    }

    if (name === "baton_update_status") {
      return jsonResult(await this.baton.updateStatus(batonUpdateStatusSchema.parse(args)));
    }

    if (name === "baton_write_report") {
      return jsonResult(await this.baton.writeReport(batonWriteReportSchema.parse(args)));
    }

    throw new Error(`Unknown conductor tool ${name}`);
  }

  private async callPermissionRequest(args: Record<string, unknown>): Promise<CallToolResult> {
    if (!(await this.approvals.isAvailable(this.sessionId))) return this.backend.callTool("request_permissions", args);

    const argsSummary = summarizeArgs(args);
    const approval = await this.approvals.request(this.sessionId, argsSummary, args);
    await this.recordPermissionRequest(approval.request.id, "pending", argsSummary);
    const decision = await approval.decision;
    await this.recordPermissionRequest(approval.request.id, decision, argsSummary);

    if (decision === "approved") return this.backend.callTool("request_permissions", args);
    const reason = decision === "timeout" ? "timed out waiting for TUI approval" : "denied by attached TUI";
    return errorResult(`Permission request ${reason}.`);
  }

  private async recordPermissionRequest(
    requestId: string,
    state: "pending" | "approved" | "denied" | "timeout",
    argsSummary: string,
  ): Promise<void> {
    await this.events.append({
      ts: new Date().toISOString(),
      sessionId: this.sessionId,
      type: "permission_request",
      requestId,
      state,
      argsSummary,
    });
  }

  private async recordToolCall(
    tool: string,
    args: Record<string, unknown>,
    started: number,
    result: CallToolResult,
    error?: string,
  ): Promise<void> {
    const eventError = error ?? (result.isError ? summarizeResult(result, 240) : undefined);
    await this.events.append({
      ts: new Date().toISOString(),
      sessionId: this.sessionId,
      type: "tool_call",
      tool,
      argsSummary: summarizeArgs(args),
      resultSummary: summarizeResult(result),
      durationMs: Math.round(performance.now() - started),
      error: eventError,
    });
  }
}

function isToolAllowed(name: string, policy: ToolPolicy): boolean {
  if (policy.allow?.length && !policy.allow.includes(name)) return false;
  if (policy.deny?.includes(name)) return false;
  return true;
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function jsonResult(value: object): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>,
    isError: false,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const conductorTools: Tool[] = [
  {
    name: "open_workspace",
    description:
      "Open the session workspace in direct mode or an isolated git worktree, then initialize ctc review checkpoints.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace path. Defaults to the session/profile workspace path." },
        mode: { type: "string", enum: ["direct", "worktree"], description: "Workspace opening mode." },
        base: { type: "string", description: "Base branch or commit for worktree mode. Defaults to HEAD." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "close_workspace",
    description: "Close the current ctc workspace and remove its managed worktree when safe.",
    inputSchema: {
      type: "object",
      properties: {
        force: { type: "boolean", description: "Remove a dirty managed worktree after review or merge." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "load_skill",
    description: "Load the full SKILL.md content for a workspace skill discovered by open_workspace.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill name from open_workspace.context.skills." },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "show_changes",
    description: "Create a review snapshot and show changes since the last checkpoint, workspace open, or HEAD.",
    inputSchema: {
      type: "object",
      properties: {
        since: { type: "string", enum: ["last_shown", "workspace_open", "head"], default: "last_shown" },
        paths: { type: "array", items: { type: "string" } },
        stat_only: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "baton_write_plan",
    description: "Write the handoff plan to .baton/plan.md in the active workspace.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "Markdown plan content." },
      },
      required: ["content"],
      additionalProperties: false,
    },
  },
  {
    name: "baton_read_plan",
    description: "Read the current handoff plan from .baton/plan.md in the active workspace.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "baton_update_status",
    description: "Update .baton/status.json with phase, step, state, and timestamp.",
    inputSchema: {
      type: "object",
      properties: {
        phase: { type: "string" },
        step: { type: "string" },
        state: { type: "string" },
        note: { type: "string" },
      },
      required: ["phase", "state"],
      additionalProperties: false,
    },
  },
  {
    name: "baton_write_report",
    description: "Write the execution report to .baton/report.md in the active workspace.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "Markdown report content." },
      },
      required: ["content"],
      additionalProperties: false,
    },
  },
];

const conductorToolNames = new Set(conductorTools.map((tool) => tool.name));
const loadSkillSchema = z.object({ name: z.string().min(1) });
