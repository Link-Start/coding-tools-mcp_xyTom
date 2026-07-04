#!/usr/bin/env node
import { Command, Option } from "commander";
import { printBatonShow } from "./baton.js";
import { printDoctor } from "./doctor.js";
import { resolveRuntimeOptions } from "../profiles/config.js";
import { startConductorServer } from "../server/mcp.js";
import { runSetupCli } from "./setup.js";
import { runTui } from "../tui/run.js";
import { cleanWorkspacesCli, mergeWorkspaceCli, printWorkspaceList } from "./workspace.js";

const program = new Command();

program
  .name("ctc")
  .description("Coding Tools Conductor")
  .version("0.1.0")
  .argument("[path]", "workspace path for the initial TUI workspace")
  .action(async (path: string | undefined) => {
    await runTui({ initialWorkspacePath: path ?? process.cwd() });
  });

program
  .command("setup")
  .argument("[path]", "repository path")
  .description("configure a workspace profile")
  .addOption(new Option("--backend <backend>", "lower MCP connection type").choices(["stdio", "http"]))
  .option("--backend-command <command...>", "stdio backend command and arguments")
  .option("--backend-command-json <json>", "stdio backend command as a JSON string array")
  .option("--backend-url <url>", "streamable HTTP backend URL")
  .option("--backend-token-env <name>", "environment variable containing the HTTP bearer token")
  .addOption(new Option("--default-mode <mode>", "default workspace opening mode").choices(["direct", "worktree"]))
  .option("--allow <tools...>", "allow only these lower tools")
  .option("--deny <tools...>", "deny these lower tools")
  .addOption(new Option("--tunnel <provider>", "optional tunnel provider").choices(["cloudflared", "none"]))
  .option("--hostname <hostname>", "tunnel hostname")
  .option("--adapter <adapters...>", "enable optional adapters, for example: chatgpt")
  .option("--yes", "accept defaults and do not prompt")
  .option("--skip-smoke", "write the profile without testing the lower backend")
  .action(async (path: string | undefined, opts: SetupCommandOptions) => {
    await runSetupCli(path, opts);
  });

program
  .command("doctor")
  .argument("[path]", "repository path")
  .description("check the saved profile, backend, worktree storage, and git version")
  .option("--skip-backend", "skip lower MCP backend smoke check")
  .action(async (path: string | undefined, opts: { skipBackend?: boolean }) => {
    await printDoctor(path, { skipBackend: opts.skipBackend });
  });

program
  .command("start")
  .argument("[path]", "workspace path")
  .description("start a conductor MCP session over stdio")
  .addOption(new Option("--backend <backend>", "lower MCP connection type").choices(["stdio", "http"]))
  .option("--backend-command <command...>", "stdio backend command and arguments")
  .option("--backend-command-json <json>", "stdio backend command as a JSON string array")
  .option("--backend-url <url>", "streamable HTTP backend URL")
  .option("--backend-token-env <name>", "environment variable containing the HTTP bearer token")
  .option("--allow <tools...>", "allow only these lower tools")
  .option("--deny <tools...>", "deny these lower tools")
  .option("--quiet", "disable concise stderr tool-call logs")
  .action(async (path: string | undefined, opts: StartCommandOptions) => {
    const runtime = await resolveRuntimeOptions({
      path,
      backend: opts.backend,
      backendCommand: opts.backendCommand,
      backendCommandJson: opts.backendCommandJson,
      backendUrl: opts.backendUrl,
      backendTokenEnv: opts.backendTokenEnv,
      allow: opts.allow,
      deny: opts.deny,
      conciseLogs: !opts.quiet,
    });
    await startConductorServer(runtime);
  });

program
  .command("tui")
  .argument("[session-id]", "session id to attach; defaults to the latest log")
  .description("deprecated alias for ctc; attaches to a v1 session when a session id is provided")
  .action(async (sessionId: string | undefined) => {
    process.stderr.write("ctc: `ctc tui` is deprecated; use `ctc` to open the TUI.\n");
    await runTui({ requestedSessionId: sessionId, initialWorkspacePath: process.cwd() });
  });

const ws = program.command("ws").description("manage ctc worktree workspaces");

ws.command("list")
  .description("list recorded ctc workspaces")
  .action(async () => {
    await printWorkspaceList();
  });

ws.command("clean")
  .description("clean recorded ctc worktrees")
  .option("--force", "remove dirty worktrees too")
  .option("--yes", "skip confirmation prompt")
  .action(async (opts: { force?: boolean; yes?: boolean }) => {
    await cleanWorkspacesCli({ force: opts.force, yes: opts.yes });
  });

ws.command("merge")
  .argument("<session-id>", "ctc session id")
  .description("apply a worktree session patch back to the source repository")
  .action(async (sessionId: string) => {
    await mergeWorkspaceCli(sessionId);
  });

const baton = program.command("baton").description("inspect baton handoff files");

baton
  .command("show")
  .argument("[path]", "workspace path")
  .description("render .baton/plan.md, status.json, and report.md")
  .action(async (path: string | undefined) => {
    await printBatonShow(path);
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`ctc: ${message}\n`);
  process.exitCode = 1;
});

interface StartCommandOptions {
  backend?: "stdio" | "http";
  backendCommand?: string[];
  backendCommandJson?: string;
  backendUrl?: string;
  backendTokenEnv?: string;
  allow?: string[];
  deny?: string[];
  quiet?: boolean;
}

interface SetupCommandOptions extends StartCommandOptions {
  defaultMode?: "direct" | "worktree";
  tunnel?: "cloudflared" | "none";
  hostname?: string;
  adapter?: string[];
  yes?: boolean;
  skipSmoke?: boolean;
}
