import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

export interface ReviewToolCaller {
  callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
}

export const showChangesSchema = z.object({
  since: z.enum(["last_shown", "workspace_open", "head"]).optional(),
  paths: z.array(z.string()).optional(),
  stat_only: z.boolean().optional(),
});

export type ShowChangesArgs = z.infer<typeof showChangesSchema>;

export interface ReviewBaselineResult {
  baselineRef: string;
  lastShownRef: string;
  snapshot: string;
}

export interface ShowChangesResult {
  since: "last_shown" | "workspace_open" | "head";
  base: string;
  snapshot: string;
  stat: string;
  diff?: string;
  truncated: boolean;
  message?: string;
}

const maxDiffChars = 20_000;

export class ReviewManager {
  private readonly backend: ReviewToolCaller;
  private readonly sessionId: string;
  private activePath?: string;

  constructor(options: { backend: ReviewToolCaller; sessionId: string }) {
    this.backend = options.backend;
    this.sessionId = options.sessionId;
  }

  async initializeBaseline(activePath: string): Promise<ReviewBaselineResult> {
    this.activePath = activePath;
    const snapshot = await this.createSnapshot(activePath, "workspace-open");
    await this.updateRef(activePath, this.baselineRef(), snapshot);
    await this.updateRef(activePath, this.lastShownRef(), snapshot);
    return { baselineRef: this.baselineRef(), lastShownRef: this.lastShownRef(), snapshot };
  }

  async showChanges(input: ShowChangesArgs): Promise<ShowChangesResult> {
    if (!this.activePath) throw new Error("No workspace has been opened for review checkpoints.");
    const args = showChangesSchema.parse(input);
    const since = args.since ?? "last_shown";
    const snapshot = await this.createSnapshot(this.activePath, "show-changes");
    const base = this.baseForSince(since);
    const pathArgs = diffPathArgs(args.paths);
    const stat = await this.git(
      `git diff --stat --find-renames ${shellQuote(base)} ${shellQuote(snapshot)}${pathArgs}`,
      this.activePath,
    );

    let diff: string | undefined;
    let truncated = false;
    if (!args.stat_only) {
      const fullDiff = await this.git(
        `git diff --find-renames ${shellQuote(base)} ${shellQuote(snapshot)}${pathArgs}`,
        this.activePath,
      );
      ({ text: diff, truncated } = truncateDiff(fullDiff));
    }

    await this.updateRef(this.activePath, this.lastShownRef(), snapshot);
    return {
      since,
      base,
      snapshot,
      stat: stat.trim() || "No changes.",
      diff,
      truncated,
      message: truncated ? "Diff truncated. Pass paths to show_changes to inspect narrower changes." : undefined,
    };
  }

  async clearRefs(): Promise<void> {
    if (!this.activePath) return;
    await this.git(`git update-ref -d ${shellQuote(this.baselineRef())} || true`, this.activePath);
    await this.git(`git update-ref -d ${shellQuote(this.lastShownRef())} || true`, this.activePath);
  }

  private async createSnapshot(activePath: string, label: string): Promise<string> {
    const script = [
      "set -e",
      "tmp=$(mktemp \"${TMPDIR:-/tmp}/ctc-index.XXXXXX\")",
      "trap 'rm -f \"$tmp\"' EXIT",
      "export GIT_AUTHOR_NAME=ctc",
      "export GIT_AUTHOR_EMAIL=ctc@example.invalid",
      "export GIT_COMMITTER_NAME=ctc",
      "export GIT_COMMITTER_EMAIL=ctc@example.invalid",
      "GIT_INDEX_FILE=\"$tmp\" git read-tree HEAD",
      "GIT_INDEX_FILE=\"$tmp\" git add -A",
      "tree=$(GIT_INDEX_FILE=\"$tmp\" git write-tree)",
      `commit=$(GIT_INDEX_FILE="$tmp" git commit-tree "$tree" -p HEAD -m ${shellQuote(`ctc review ${label}`)})`,
      "printf '%s\\n' \"$commit\"",
    ].join("\n");
    const output = await this.git(script, activePath);
    const snapshot = output.trim().split(/\s+/).at(-1);
    if (!snapshot) throw new Error("Failed to create review snapshot.");
    return snapshot;
  }

  private async updateRef(activePath: string, ref: string, commit: string): Promise<void> {
    await this.git(`git update-ref ${shellQuote(ref)} ${shellQuote(commit)}`, activePath);
  }

  private baseForSince(since: "last_shown" | "workspace_open" | "head"): string {
    if (since === "head") return "HEAD";
    if (since === "workspace_open") return this.baselineRef();
    return this.lastShownRef();
  }

  private baselineRef(): string {
    return `refs/ctc/review/${this.sessionId}/baseline`;
  }

  private lastShownRef(): string {
    return `refs/ctc/review/${this.sessionId}/last-shown`;
  }

  private async git(cmd: string, workdir: string): Promise<string> {
    const result = await this.backend.callTool("exec_command", { cmd, workdir, verbosity: "full" });
    if (result.isError) throw new Error(resultText(result) || `Command failed: ${cmd}`);
    assertSuccessfulCommand(result, cmd);
    return resultOutput(result);
  }
}

function diffPathArgs(paths: string[] | undefined): string {
  if (!paths?.length) return "";
  return ` -- ${paths.map(shellQuote).join(" ")}`;
}

function truncateDiff(diff: string): { text: string; truncated: boolean } {
  if (diff.length <= maxDiffChars) return { text: diff, truncated: false };
  return { text: `${diff.slice(0, maxDiffChars)}\n... diff truncated ...\n`, truncated: true };
}

function resultOutput(result: CallToolResult): string {
  const structured = result.structuredContent;
  for (const key of ["stdout", "output", "text"] as const) {
    const value = structured?.[key];
    if (typeof value === "string") return value;
  }
  return resultText(result);
}

function assertSuccessfulCommand(result: CallToolResult, cmd: string): void {
  const structured = result.structuredContent;
  const exitCode = structured?.exit_code ?? structured?.exitCode;
  if (typeof exitCode === "number" && exitCode !== 0) {
    const stderr = typeof structured?.stderr === "string" ? structured.stderr : resultText(result);
    throw new Error(`Command failed (${String(exitCode)}): ${cmd}\n${stderr}`);
  }
}

function resultText(result: CallToolResult): string {
  return result.content
    .map((item) => (item.type === "text" ? item.text : ""))
    .filter(Boolean)
    .join("\n");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
