import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface, type Interface } from "node:readline/promises";
import { setTimeout as delay } from "node:timers/promises";
import { render, Box, Text } from "ink";
import { createElement } from "react";
import { BackendClient } from "../proxy/client.js";
import { defaultBackendForPath, resolveProfileTargetPath, writeProfileForPath } from "../profiles/config.js";
import type { BackendConfig, ToolPolicy, WorkspaceMode, WorkspaceProfile } from "../shared/types.js";

export interface SetupOptions {
  backend?: "stdio" | "http";
  backendCommand?: string[];
  backendCommandJson?: string;
  backendUrl?: string;
  backendTokenEnv?: string;
  defaultMode?: WorkspaceMode;
  allow?: string[];
  deny?: string[];
  tunnel?: "cloudflared" | "none";
  hostname?: string;
  adapter?: string[];
  yes?: boolean;
  skipSmoke?: boolean;
}

interface SetupAnswers {
  repoPath: string;
  backend: BackendConfig;
  defaultMode: WorkspaceMode;
  toolPolicy?: ToolPolicy;
  tunnel: { provider: "cloudflared" | "none"; hostname?: string };
  adapters: string[];
}

export async function runSetupCli(path: string | undefined, options: SetupOptions): Promise<void> {
  const requestedPath = resolve(path ?? process.cwd());
  const repoPath = await resolveProfileTargetPath(requestedPath);
  const answers = options.yes || !process.stdin.isTTY ? answersFromOptions(repoPath, options) : await promptForAnswers(repoPath, options);
  const profile = buildProfile(answers);

  if (!options.skipSmoke) await smokeBackend(profile.backend);
  const file = await writeProfileForPath(profile.repoPath, profile);
  process.stdout.write(`Profile written to ${file}.\n`);
  process.stdout.write(`Next: ctc start ${profile.repoPath}\n`);
}

function buildProfile(answers: SetupAnswers): WorkspaceProfile {
  return {
    repoPath: answers.repoPath,
    backend: answers.backend,
    defaultMode: answers.defaultMode,
    toolPolicy: answers.toolPolicy,
    tunnel: answers.tunnel,
    adapters: answers.adapters,
  };
}

async function promptForAnswers(repoPath: string, options: SetupOptions): Promise<SetupAnswers> {
  const frame = render(createElement(SetupFrame, { repoPath }));
  await delay(20);
  const rl = createInterface({ input, output });
  try {
    const confirmedRepo = resolve(await ask(rl, "Repository path", repoPath));
    const finalRepo = await resolveProfileTargetPath(confirmedRepo);
    const backendType = await choose(rl, "Backend", ["stdio", "http"], options.backend ?? "stdio");
    const backend = backendType === "http" ? await promptHttpBackend(rl, options) : await promptStdioBackend(rl, finalRepo, options);
    const defaultMode = await choose(rl, "Default workspace mode", ["worktree", "direct"], options.defaultMode ?? "worktree");
    const tunnelProvider = await choose(rl, "Tunnel provider", ["none", "cloudflared"], options.tunnel ?? "none");
    const hostname = tunnelProvider === "cloudflared" ? await ask(rl, "Tunnel hostname", options.hostname ?? "") : undefined;
    const adapterText = await ask(rl, "Adapters (comma-separated, blank for none)", options.adapter?.join(",") ?? "");
    return {
      repoPath: finalRepo,
      backend,
      defaultMode,
      toolPolicy: policyFromOptions(options),
      tunnel: { provider: tunnelProvider, hostname: hostname || undefined },
      adapters: parseAdapters(adapterText),
    };
  } finally {
    frame.unmount();
    rl.close();
  }
}

function answersFromOptions(repoPath: string, options: SetupOptions): SetupAnswers {
  const backend = resolveBackendFromOptions(repoPath, options);
  return {
    repoPath,
    backend,
    defaultMode: options.defaultMode ?? "worktree",
    toolPolicy: policyFromOptions(options),
    tunnel: { provider: options.tunnel ?? "none", hostname: options.hostname },
    adapters: options.adapter ?? [],
  };
}

async function promptStdioBackend(rl: Interface, repoPath: string, options: SetupOptions): Promise<BackendConfig> {
  const detected = (await commandExists("coding-tools-mcp")) ? "coding-tools-mcp" : undefined;
  const fallback = defaultBackendForPath(repoPath).command.join(" ");
  const defaultCommand = options.backendCommandJson
    ? parseBackendCommandJson(options.backendCommandJson).join(" ")
    : options.backendCommand?.length
      ? options.backendCommand.join(" ")
      : detected
        ? fallback
        : fallback;
  const commandText = await ask(rl, "Lower MCP stdio command", defaultCommand);
  return { type: "stdio", command: splitCommand(commandText) };
}

async function promptHttpBackend(rl: Interface, options: SetupOptions): Promise<BackendConfig> {
  const url = await ask(rl, "Lower MCP HTTP URL", options.backendUrl ?? "http://127.0.0.1:8765/mcp");
  const tokenEnv = await ask(rl, "Bearer token env var (blank for none)", options.backendTokenEnv ?? "");
  return { type: "http", url, tokenRef: tokenEnv ? `env:${tokenEnv}` : undefined };
}

function resolveBackendFromOptions(repoPath: string, options: SetupOptions): BackendConfig {
  if (options.backend === "http" || options.backendUrl) {
    if (!options.backendUrl) throw new Error("--backend-url is required when configuring the http backend.");
    return { type: "http", url: options.backendUrl, tokenRef: options.backendTokenEnv ? `env:${options.backendTokenEnv}` : undefined };
  }
  if (options.backendCommandJson) return { type: "stdio", command: parseBackendCommandJson(options.backendCommandJson) };
  if (options.backendCommand?.length) return { type: "stdio", command: options.backendCommand };
  return defaultBackendForPath(repoPath);
}

async function smokeBackend(backend: BackendConfig): Promise<void> {
  const client = new BackendClient(backend);
  try {
    await client.start();
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function commandExists(command: string): Promise<boolean> {
  const pathEnv = process.env.PATH ?? "";
  for (const directory of pathEnv.split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, command);
    try {
      await access(candidate, constants.X_OK);
      return true;
    } catch {
      // Try the next PATH entry.
    }
  }
  return false;
}

async function ask(rl: Interface, label: string, defaultValue: string): Promise<string> {
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  const answer = (await rl.question(`${label}${suffix}: `)).trim();
  return answer || defaultValue;
}

async function choose<T extends string>(rl: Interface, label: string, choices: readonly T[], defaultValue: T): Promise<T> {
  const answer = await ask(rl, `${label} (${choices.join("/")})`, defaultValue);
  if (choices.includes(answer as T)) return answer as T;
  process.stdout.write(`Invalid choice ${answer}; using ${defaultValue}.\n`);
  return defaultValue;
}

function splitCommand(value: string): string[] {
  const command = value.trim().split(/\s+/u).filter(Boolean);
  if (!command.length) throw new Error("Backend command cannot be empty.");
  return command;
}

function parseBackendCommandJson(value: string): string[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string") || parsed.length === 0) {
    throw new Error("Backend command JSON must be a non-empty string array.");
  }
  return parsed;
}

function parseAdapters(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function policyFromOptions(options: SetupOptions): ToolPolicy | undefined {
  const policy: ToolPolicy = {};
  if (options.allow?.length) policy.allow = options.allow;
  if (options.deny?.length) policy.deny = options.deny;
  return policy.allow || policy.deny ? policy : undefined;
}

function SetupFrame(props: { repoPath: string }) {
  return createElement(
    Box,
    { flexDirection: "column", paddingBottom: 1 },
    createElement(Text, { bold: true }, "Coding Tools Conductor setup"),
    createElement(Text, null, `Profile target: ${props.repoPath}`),
    createElement(Text, { color: "gray" }, "Answer the prompts below. Secrets are stored as env var references only."),
  );
}
