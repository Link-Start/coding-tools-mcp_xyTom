import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { BackendClient } from "../proxy/client.js";
import { ctcHome, profilePathForRepo, readProfileForPath } from "../profiles/config.js";
import type { WorkspaceProfile } from "../shared/types.js";

const execFileAsync = promisify(execFile);
const EXPECTED_LOWER_TOOLS = ["server_info", "set_default_cwd", "exec_command"];

export type DoctorStatus = "pass" | "warn" | "fail";

export interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  detail: string;
}

export interface DoctorOptions {
  skipBackend?: boolean;
}

export async function runDoctor(path: string | undefined, options: DoctorOptions = {}): Promise<DoctorCheck[]> {
  const repoPath = resolve(path ?? process.cwd());
  const checks: DoctorCheck[] = [];
  let profile: WorkspaceProfile | undefined;

  try {
    profile = await readProfileForPath(repoPath);
    if (!profile) {
      checks.push({ name: "profile", status: "fail", detail: `No profile found at ${profilePathForRepo(repoPath)}.` });
    } else {
      checks.push({ name: "profile", status: "pass", detail: `Loaded ${profilePathForRepo(repoPath)}.` });
    }
  } catch (error) {
    checks.push({ name: "profile", status: "fail", detail: errorMessage(error) });
  }

  if (!profile) {
    checks.push(await checkGitVersion());
    checks.push(await checkWorktreeDirectory());
    return checks;
  }

  checks.push(checkTokenReference(profile));
  checks.push(await checkGitVersion());
  checks.push(await checkWorktreeDirectory());

  if (options.skipBackend) {
    checks.push({ name: "backend", status: "warn", detail: "Skipped by --skip-backend." });
  } else {
    checks.push(await checkBackend(profile));
  }

  return checks;
}

export async function printDoctor(path: string | undefined, options: DoctorOptions = {}): Promise<void> {
  const checks = await runDoctor(path, options);
  const width = Math.max(...checks.map((check) => check.name.length), "check".length);
  process.stdout.write(`${pad("status", 6)}  ${pad("check", width)}  detail\n`);
  for (const check of checks) {
    process.stdout.write(`${pad(check.status.toUpperCase(), 6)}  ${pad(check.name, width)}  ${check.detail}\n`);
  }
  if (checks.some((check) => check.status === "fail")) process.exitCode = 1;
}

function checkTokenReference(profile: WorkspaceProfile): DoctorCheck {
  if (profile.backend.type !== "http" || !profile.backend.tokenRef) {
    return { name: "token", status: "pass", detail: "No bearer token reference required." };
  }
  if (!profile.backend.tokenRef.startsWith("env:")) {
    return { name: "token", status: "fail", detail: "Only env:<NAME> token references are supported." };
  }
  const envName = profile.backend.tokenRef.slice("env:".length);
  if (!process.env[envName]) return { name: "token", status: "fail", detail: `Environment variable ${envName} is not set.` };
  return { name: "token", status: "pass", detail: `Environment variable ${envName} is set.` };
}

async function checkBackend(profile: WorkspaceProfile): Promise<DoctorCheck> {
  const client = new BackendClient(profile.backend);
  try {
    await client.start();
    const tools = client.tools().map((tool) => tool.name);
    const missing = EXPECTED_LOWER_TOOLS.filter((tool) => !tools.includes(tool));
    if (missing.length) {
      return { name: "backend", status: "fail", detail: `Reachable, but missing tools: ${missing.join(", ")}.` };
    }
    return { name: "backend", status: "pass", detail: `Reachable with ${String(tools.length)} tools.` };
  } catch (error) {
    return { name: "backend", status: "fail", detail: errorMessage(error) };
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function checkWorktreeDirectory(): Promise<DoctorCheck> {
  const dir = join(ctcHome(), "worktrees");
  const probe = join(dir, ".doctor-write-test");
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(probe, "ok\n", "utf8");
    await rm(probe, { force: true });
    return { name: "worktrees", status: "pass", detail: `${dir} is writable.` };
  } catch (error) {
    return { name: "worktrees", status: "fail", detail: errorMessage(error) };
  }
}

async function checkGitVersion(): Promise<DoctorCheck> {
  try {
    const { stdout } = await execFileAsync("git", ["--version"]);
    const version = parseGitVersion(stdout);
    if (!version) return { name: "git", status: "fail", detail: `Could not parse version from ${stdout.trim()}.` };
    const ok = version.major > 2 || (version.major === 2 && version.minor >= 38);
    return {
      name: "git",
      status: ok ? "pass" : "fail",
      detail: `${stdout.trim()}${ok ? "" : "; ctc requires git >= 2.38."}`,
    };
  } catch (error) {
    return { name: "git", status: "fail", detail: errorMessage(error) };
  }
}

function parseGitVersion(output: string): { major: number; minor: number } | undefined {
  const match = /git version\s+(\d+)\.(\d+)/u.exec(output);
  if (!match?.[1] || !match[2]) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]) };
}

function pad(value: string, width: number): string {
  return value.padEnd(width, " ");
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function profileExists(path: string): boolean {
  return existsSync(profilePathForRepo(resolve(path)));
}
