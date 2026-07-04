import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import type { BackendConfig, RuntimeOptions, ToolPolicy, WorkspaceProfile } from "../shared/types.js";
import { resolveGitRoot } from "../workspace/git.js";

type StdioBackendConfig = Extract<BackendConfig, { type: "stdio" }>;

const backendSchema = z.union([
  z.object({ type: z.literal("stdio"), command: z.array(z.string()).min(1) }),
  z.object({ type: z.literal("http"), url: z.string().url(), tokenRef: z.string().optional() }),
]);

const profileSchema = z.object({
  repoPath: z.string(),
  backend: backendSchema,
  defaultMode: z.enum(["direct", "worktree"]).optional(),
  permissionMode: z.enum(["safe", "trusted"]).optional(),
  httpPort: z.number().int().min(1).max(65535).optional(),
  toolPolicy: z.object({ allow: z.array(z.string()).optional(), deny: z.array(z.string()).optional() }).optional(),
  tunnel: z
    .object({ provider: z.enum(["cloudflared", "none"]), hostname: z.string().optional(), enabled: z.boolean().optional() })
    .optional(),
  adapters: z.array(z.string()).optional(),
});

export interface ResolveRuntimeInput {
  path?: string;
  backend?: "stdio" | "http";
  backendCommand?: string[];
  backendCommandJson?: string;
  backendUrl?: string;
  backendTokenEnv?: string;
  allow?: string[];
  deny?: string[];
  conciseLogs?: boolean;
}

export async function resolveRuntimeOptions(input: ResolveRuntimeInput): Promise<RuntimeOptions> {
  const workspacePath = await resolveProfileTargetPath(input.path ?? process.cwd());
  const profile = await readProfileForPath(workspacePath);
  const backend = resolveBackend(workspacePath, profile, input);
  const toolPolicy = mergeToolPolicy(profile?.toolPolicy, { allow: input.allow, deny: input.deny });
  const defaultMode = profile?.defaultMode ?? "direct";
  const adapters = profile?.adapters ?? [];
  const sessionId = `ctc-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const logPath = `${ctcHome()}/logs/${sessionId}.jsonl`;
  await mkdir(`${ctcHome()}/logs`, { recursive: true });
  return {
    sessionId,
    workspacePath,
    defaultMode,
    backend,
    toolPolicy,
    adapters,
    logPath,
    conciseLogs: input.conciseLogs ?? true,
  };
}

export async function readProfileForPath(repoPath: string): Promise<WorkspaceProfile | undefined> {
  const file = profilePathForRepo(await resolveProfileTargetPath(repoPath));
  if (!existsSync(file)) return undefined;
  const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
  return profileSchema.parse(parsed);
}

export async function writeProfileForPath(repoPath: string, profile: WorkspaceProfile): Promise<string> {
  const targetPath = await resolveProfileTargetPath(repoPath);
  const normalized = profileSchema.parse({ ...profile, repoPath: targetPath });
  const file = profilePathForRepo(targetPath);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  return file;
}

export function defaultBackendForPath(repoPath: string): StdioBackendConfig {
  return { type: "stdio", command: ["coding-tools-mcp", "--stdio", "--workspace", resolve(repoPath)] };
}

export function profilePathForRepo(repoPath: string): string {
  return `${ctcHome()}/profiles/${repoHash(repoPath)}.json`;
}

export function ctcHome(): string {
  return process.env.CTC_HOME || `${homedir()}/.ctc`;
}

export async function resolveProfileTargetPath(path: string): Promise<string> {
  const requestedPath = resolve(path);
  return (await resolveGitRoot(requestedPath)) ?? requestedPath;
}

function resolveBackend(
  workspacePath: string,
  profile: WorkspaceProfile | undefined,
  input: ResolveRuntimeInput,
): BackendConfig {
  if (input.backend === "http" || input.backendUrl) {
    const url = input.backendUrl ?? (profile?.backend.type === "http" ? profile.backend.url : undefined);
    if (!url) throw new Error("--backend-url is required for http backend mode");
    const tokenRef = input.backendTokenEnv ? `env:${input.backendTokenEnv}` : profile?.backend.type === "http" ? profile.backend.tokenRef : undefined;
    return { type: "http", url, tokenRef };
  }
  if (input.backendCommandJson) {
    const parsed: unknown = JSON.parse(input.backendCommandJson);
    const command = z.array(z.string()).min(1).parse(parsed);
    return { type: "stdio", command };
  }
  if (input.backendCommand?.length) return { type: "stdio", command: input.backendCommand };
  if (profile?.backend.type === "stdio") return profile.backend;
  return defaultBackendForPath(workspacePath);
}

function mergeToolPolicy(profilePolicy: ToolPolicy | undefined, cliPolicy: ToolPolicy): ToolPolicy {
  return {
    allow: cliPolicy.allow?.length ? cliPolicy.allow : profilePolicy?.allow,
    deny: cliPolicy.deny?.length ? cliPolicy.deny : profilePolicy?.deny,
  };
}

function repoHash(repoPath: string): string {
  return createHash("sha256").update(resolve(repoPath)).digest("hex").slice(0, 16);
}
