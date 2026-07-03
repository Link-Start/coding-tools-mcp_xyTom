import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  type ReadResourceResult,
  type Resource,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

export const chatGptAdapterName = "chatgpt";
export const chatGptWidgetMimeType = "text/html;profile=mcp-app";

interface ChatGptWidgetDefinition {
  toolName: string;
  uri: string;
  name: string;
  title: string;
  description: string;
  widgetDescription: string;
  invoking: string;
  invoked: string;
  outputSchema: NonNullable<Tool["outputSchema"]>;
  html: string;
}

const widgets: readonly ChatGptWidgetDefinition[] = [
  {
    toolName: "open_workspace",
    uri: "ui://ctc/open_workspace.html",
    name: "ctc_open_workspace_widget",
    title: "CTC Workspace",
    description: "Shows the opened Coding Tools Conductor workspace and context guide.",
    widgetDescription: "A compact workspace summary with mode, paths, instruction files, and discovered skills.",
    invoking: "Opening workspace",
    invoked: "Workspace opened",
    outputSchema: {
      type: "object",
      properties: {
        workspace: { type: "object" },
        context: { type: "object" },
        review: { type: "object" },
      },
    },
    html: widgetHtml("workspace"),
  },
  {
    toolName: "show_changes",
    uri: "ui://ctc/show_changes.html",
    name: "ctc_show_changes_widget",
    title: "CTC Review Diff",
    description: "Shows a review checkpoint stat and diff preview.",
    widgetDescription: "A review checkpoint card with changed file stats and a readable diff preview.",
    invoking: "Preparing diff",
    invoked: "Diff ready",
    outputSchema: {
      type: "object",
      properties: {
        since: { type: "string" },
        base: { type: "string" },
        snapshot: { type: "string" },
        stat: { type: "string" },
        diff: { type: "string" },
        truncated: { type: "boolean" },
      },
    },
    html: widgetHtml("diff"),
  },
  {
    toolName: "baton_update_status",
    uri: "ui://ctc/baton_status.html",
    name: "ctc_baton_status_widget",
    title: "CTC Baton Status",
    description: "Shows baton handoff progress after status updates.",
    widgetDescription: "A baton progress card showing phase, step, state, note, and update time.",
    invoking: "Updating baton",
    invoked: "Baton updated",
    outputSchema: {
      type: "object",
      properties: {
        phase: { type: "string" },
        step: { type: "string" },
        state: { type: "string" },
        note: { type: "string" },
        updatedAt: { type: "string" },
      },
    },
    html: widgetHtml("baton"),
  },
];

const widgetsByTool = new Map(widgets.map((widget) => [widget.toolName, widget]));
const widgetsByUri = new Map(widgets.map((widget) => [widget.uri, widget]));

export function isChatGptAdapterEnabled(adapters: readonly string[] | undefined): boolean {
  return adapters?.includes(chatGptAdapterName) ?? false;
}

export function decorateToolsForChatGpt(tools: readonly Tool[]): Tool[] {
  return tools.map((tool) => {
    const widget = widgetsByTool.get(tool.name);
    if (!widget) return tool;

    const existingMeta = tool._meta ?? {};
    const existingUi = isRecord(existingMeta.ui) ? existingMeta.ui : {};
    return {
      ...tool,
      outputSchema: tool.outputSchema ?? widget.outputSchema,
      _meta: {
        ...existingMeta,
        ui: {
          ...existingUi,
          resourceUri: widget.uri,
          visibility: ["model", "app"],
        },
        "openai/outputTemplate": widget.uri,
        "openai/widgetAccessible": true,
        "openai/toolInvocation/invoking": widget.invoking,
        "openai/toolInvocation/invoked": widget.invoked,
      },
    };
  });
}

export function listChatGptWidgetResources(): Resource[] {
  return widgets.map((widget) => ({
    uri: widget.uri,
    name: widget.name,
    title: widget.title,
    description: widget.description,
    mimeType: chatGptWidgetMimeType,
    size: Buffer.byteLength(widget.html),
  }));
}

export function readChatGptWidgetResource(uri: string): ReadResourceResult {
  const widget = widgetsByUri.get(uri);
  if (!widget) throw new Error(`Unknown ChatGPT widget resource ${uri}`);
  return {
    contents: [
      {
        uri: widget.uri,
        mimeType: chatGptWidgetMimeType,
        text: widget.html,
        _meta: widgetResourceMeta(widget.widgetDescription),
      },
    ],
  };
}

export function registerChatGptAdapter(server: Server): void {
  server.setRequestHandler(ListResourcesRequestSchema, () => ({ resources: listChatGptWidgetResources() }));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, () => ({ resourceTemplates: [] }));
  server.setRequestHandler(ReadResourceRequestSchema, (request) => readChatGptWidgetResource(request.params.uri));
}

function widgetResourceMeta(description: string): Record<string, unknown> {
  const csp = { connectDomains: [], resourceDomains: [], frameDomains: [] };
  return {
    ui: { prefersBorder: true, csp },
    "openai/widgetDescription": description,
    "openai/widgetPrefersBorder": true,
    "openai/widgetCSP": { connect_domains: [], resource_domains: [], frame_domains: [] },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function widgetHtml(kind: "workspace" | "diff" | "baton"): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      body { margin: 0; background: transparent; color: CanvasText; }
      .card { box-sizing: border-box; display: grid; gap: 12px; padding: 14px; min-width: 0; }
      .header { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
      h1 { margin: 0; font-size: 16px; line-height: 1.25; font-weight: 650; }
      .pill { border: 1px solid color-mix(in srgb, CanvasText 18%, transparent); border-radius: 999px; padding: 2px 8px; font-size: 12px; white-space: nowrap; }
      .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; }
      .field { border: 1px solid color-mix(in srgb, CanvasText 12%, transparent); border-radius: 8px; padding: 8px; min-width: 0; }
      .label { color: color-mix(in srgb, CanvasText 62%, transparent); font-size: 11px; text-transform: uppercase; }
      .value { margin-top: 4px; overflow-wrap: anywhere; font-size: 13px; }
      pre { margin: 0; overflow: auto; max-height: 260px; border: 1px solid color-mix(in srgb, CanvasText 12%, transparent); border-radius: 8px; padding: 10px; font-size: 12px; line-height: 1.45; white-space: pre-wrap; }
      ul { margin: 6px 0 0; padding-left: 18px; }
      li { margin: 3px 0; overflow-wrap: anywhere; }
      .muted { color: color-mix(in srgb, CanvasText 62%, transparent); font-size: 12px; }
    </style>
  </head>
  <body>
    <main id="app" class="card"></main>
    <script>
      const kind = ${JSON.stringify(kind)};
      const state = {
        input: window.openai && window.openai.toolInput ? window.openai.toolInput : null,
        output: window.openai && window.openai.toolOutput ? window.openai.toolOutput : null
      };

      window.addEventListener("message", (event) => {
        if (event.source !== window.parent) return;
        const message = event.data;
        if (!message || message.jsonrpc !== "2.0") return;
        if (message.method === "ui/notifications/tool-result") {
          state.output = message.params && message.params.structuredContent ? message.params.structuredContent : null;
          render();
        }
        if (message.method === "ui/notifications/tool-input") {
          state.input = message.params || null;
          render();
        }
      }, { passive: true });

      function render() {
        const app = document.getElementById("app");
        const data = state.output || {};
        if (kind === "workspace") app.innerHTML = renderWorkspace(data);
        if (kind === "diff") app.innerHTML = renderDiff(data);
        if (kind === "baton") app.innerHTML = renderBaton(data);
      }

      function renderWorkspace(data) {
        const workspace = data.workspace || {};
        const context = data.context || {};
        const instructions = Array.isArray(context.instructionFiles) ? context.instructionFiles : [];
        const skills = Array.isArray(context.skills) ? context.skills : [];
        return header("Workspace", workspace.mode || "ctc") +
          '<section class="grid">' +
          field("active path", workspace.activePath) +
          field("source path", workspace.sourcePath) +
          field("repo root", workspace.repoRoot || context.rootPath) +
          field("base", workspace.baseCommit || workspace.baseRef) +
          '</section>' +
          listBlock("Instruction files", instructions.map((item) => item.path + " (" + item.bytes + " bytes)")) +
          listBlock("Skills", skills.map((item) => item.name + (item.description ? ": " + item.description : "")));
      }

      function renderDiff(data) {
        return header("Review checkpoint", data.since || "changes") +
          '<section class="grid">' +
          field("base", data.base) +
          field("snapshot", data.snapshot) +
          field("truncated", data.truncated ? "yes" : "no") +
          '</section>' +
          '<pre>' + escapeHtml(data.diff || data.stat || "No changes.") + '</pre>';
      }

      function renderBaton(data) {
        return header("Baton status", data.state || "updated") +
          '<section class="grid">' +
          field("phase", data.phase) +
          field("step", data.step) +
          field("state", data.state) +
          field("updated", data.updatedAt) +
          '</section>' +
          (data.note ? '<p class="muted">' + escapeHtml(data.note) + '</p>' : '');
      }

      function header(title, detail) {
        return '<div class="header"><h1>' + escapeHtml(title) + '</h1><span class="pill">' + escapeHtml(detail || "ready") + '</span></div>';
      }

      function field(label, value) {
        return '<div class="field"><div class="label">' + escapeHtml(label) + '</div><div class="value">' + escapeHtml(value || "-") + '</div></div>';
      }

      function listBlock(title, items) {
        if (!items.length) return '<section><div class="label">' + escapeHtml(title) + '</div><p class="muted">None found.</p></section>';
        return '<section><div class="label">' + escapeHtml(title) + '</div><ul>' + items.map((item) => '<li>' + escapeHtml(item) + '</li>').join("") + '</ul></section>';
      }

      function escapeHtml(value) {
        return String(value == null ? "" : value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
      }

      render();
    </script>
  </body>
</html>`;
}
