import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { z } from "zod";

export const batonWritePlanSchema = z.object({ content: z.string() });
export const batonWriteReportSchema = z.object({ content: z.string() });
export const batonUpdateStatusSchema = z.object({
  phase: z.string().min(1),
  step: z.string().min(1).optional(),
  state: z.string().min(1),
  note: z.string().optional(),
});

export type BatonWritePlanArgs = z.infer<typeof batonWritePlanSchema>;
export type BatonWriteReportArgs = z.infer<typeof batonWriteReportSchema>;
export type BatonUpdateStatusArgs = z.infer<typeof batonUpdateStatusSchema>;

export interface BatonStatus {
  phase: string;
  step?: string;
  state: string;
  note?: string;
  updatedAt: string;
}

export interface BatonFileResult {
  path: string;
  bytes: number;
}

export interface BatonReadPlanResult {
  exists: boolean;
  path: string;
  content: string;
}

export interface BatonBundle {
  root: string;
  batonDir: string;
  plan?: { path: string; content: string };
  status?: BatonStatus;
  report?: { path: string; content: string };
}

const planFile = "plan.md";
const statusFile = "status.json";
const reportFile = "report.md";

export class BatonManager {
  private readonly rootProvider: () => string;

  constructor(rootProvider: () => string) {
    this.rootProvider = rootProvider;
  }

  async writePlan(input: BatonWritePlanArgs): Promise<BatonFileResult> {
    const parsed = batonWritePlanSchema.parse(input);
    return writeBatonFile(this.rootProvider(), planFile, parsed.content);
  }

  async readPlan(): Promise<BatonReadPlanResult> {
    const root = this.rootProvider();
    const path = batonPath(root, planFile);
    if (!existsSync(path)) return { exists: false, path, content: "" };
    return { exists: true, path, content: await readFile(path, "utf8") };
  }

  async updateStatus(input: BatonUpdateStatusArgs): Promise<BatonStatus> {
    const parsed = batonUpdateStatusSchema.parse(input);
    const status: BatonStatus = { ...parsed, updatedAt: new Date().toISOString() };
    await writeBatonFile(this.rootProvider(), statusFile, `${JSON.stringify(status, null, 2)}\n`);
    return status;
  }

  async writeReport(input: BatonWriteReportArgs): Promise<BatonFileResult> {
    const parsed = batonWriteReportSchema.parse(input);
    return writeBatonFile(this.rootProvider(), reportFile, parsed.content);
  }
}

export async function readBatonBundle(rootPath: string): Promise<BatonBundle> {
  const root = resolve(rootPath);
  const dir = batonDir(root);
  const [plan, status, report] = await Promise.all([
    readOptionalText(root, planFile),
    readOptionalStatus(root),
    readOptionalText(root, reportFile),
  ]);
  return {
    root,
    batonDir: dir,
    plan: plan !== undefined ? { path: batonPath(root, planFile), content: plan } : undefined,
    status,
    report: report !== undefined ? { path: batonPath(root, reportFile), content: report } : undefined,
  };
}

export function formatBatonBundle(bundle: BatonBundle): string {
  const lines: string[] = [`Baton workspace: ${bundle.root}`, `Directory: ${bundle.batonDir}`, ""];
  if (bundle.status) {
    lines.push("Status:");
    lines.push(`  phase: ${bundle.status.phase}`);
    if (bundle.status.step) lines.push(`  step: ${bundle.status.step}`);
    lines.push(`  state: ${bundle.status.state}`);
    if (bundle.status.note) lines.push(`  note: ${bundle.status.note}`);
    lines.push(`  updatedAt: ${bundle.status.updatedAt}`);
  } else {
    lines.push("Status: not written yet");
  }

  lines.push("", "Plan:");
  lines.push(bundle.plan?.content.trimEnd() || "  not written yet");
  lines.push("", "Report:");
  lines.push(bundle.report?.content.trimEnd() || "  not written yet");
  lines.push("");
  return lines.join("\n");
}

export function batonDir(rootPath: string): string {
  return join(resolve(rootPath), ".baton");
}

function batonPath(rootPath: string, file: string): string {
  const root = resolve(rootPath);
  const dir = batonDir(root);
  const path = resolve(dir, file);
  const inside = relative(dir, path);
  if (inside.startsWith("..") || inside === "" || basename(path) !== file) {
    throw new Error(`Invalid baton path ${file}`);
  }
  return path;
}

async function ensureBatonDir(rootPath: string): Promise<void> {
  await mkdir(join(batonDir(rootPath), "artifacts"), { recursive: true });
}

async function writeBatonFile(rootPath: string, file: string, content: string): Promise<BatonFileResult> {
  await ensureBatonDir(rootPath);
  const path = batonPath(rootPath, file);
  await writeFile(path, content, "utf8");
  return { path, bytes: Buffer.byteLength(content) };
}

async function readOptionalText(rootPath: string, file: string): Promise<string | undefined> {
  const path = batonPath(rootPath, file);
  if (!existsSync(path)) return undefined;
  return readFile(path, "utf8");
}

async function readOptionalStatus(rootPath: string): Promise<BatonStatus | undefined> {
  const text = await readOptionalText(rootPath, statusFile);
  if (!text) return undefined;
  return z
    .object({
      phase: z.string(),
      step: z.string().optional(),
      state: z.string(),
      note: z.string().optional(),
      updatedAt: z.string(),
    })
    .parse(JSON.parse(text));
}
