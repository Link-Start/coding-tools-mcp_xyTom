export interface SlashCommand {
  name: string;
  usage: string;
  description: string;
  aliases?: string[];
  stage: "available" | "planned";
}

export interface ParsedSlashCommand {
  raw: string;
  name: string;
  args: string[];
}

export interface ParsedNewCommand {
  path?: string;
  mode?: "direct" | "worktree";
  resume?: string;
}

export interface ParsedCloseCommand {
  force: boolean;
}

export interface ParsedTunnelCommand {
  action: "start" | "stop" | "status";
}

export const slashCommands: SlashCommand[] = [
  {
    name: "help",
    usage: "/help",
    description: "Show TUI commands and key bindings.",
    aliases: ["?"],
    stage: "available",
  },
  {
    name: "switch",
    usage: "/switch [n|session]",
    description: "Switch to another attached session tab.",
    stage: "available",
  },
  {
    name: "diff",
    usage: "/diff [rev]",
    description: "Show the latest recorded review checkpoint for this session.",
    stage: "available",
  },
  {
    name: "approvals",
    usage: "/approvals",
    description: "List pending approvals across attached sessions.",
    stage: "available",
  },
  {
    name: "baton",
    usage: "/baton",
    description: "Show the active session baton plan, status, and report.",
    stage: "available",
  },
  {
    name: "doctor",
    usage: "/doctor",
    description: "Run environment checks. Not wired into the TUI yet - run: ctc doctor",
    stage: "planned",
  },
  {
    name: "clean",
    usage: "/clean",
    description: "Clean managed workspace records. Not wired into the TUI yet - run: ctc ws clean",
    stage: "planned",
  },
  {
    name: "messages",
    usage: "/messages",
    description: "Show the recent TUI status message history.",
    stage: "available",
  },
  {
    name: "quit",
    usage: "/quit",
    description: "Exit the TUI.",
    aliases: ["q"],
    stage: "available",
  },
  {
    name: "new",
    usage: "/new [path] [--direct|--worktree] [--resume <wt>]",
    description: "Create a TUI-owned workspace session.",
    stage: "available",
  },
  {
    name: "close",
    usage: "/close [--force]",
    description: "Close the current workspace session.",
    stage: "available",
  },
  {
    name: "merge",
    usage: "/merge",
    description: "Merge a managed worktree back to the source repo.",
    stage: "available",
  },
  {
    name: "tunnel",
    usage: "/tunnel [start|stop]",
    description: "Manage a public MCP tunnel and bearer token.",
    stage: "available",
  },
  {
    name: "config",
    usage: "/config [mode|permission|tunnel] ...",
    description: "View or update the current repo profile.",
    stage: "available",
  },
];

export function parseSlashCommand(input: string): ParsedSlashCommand | undefined {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return undefined;
  const parts = tokenizeArgs(trimmed.slice(1));
  const name = parts[0]?.toLowerCase();
  if (!name) return undefined;
  return { raw: trimmed, name, args: parts.slice(1) };
}

export function parseNewCommand(args: string[]): ParsedNewCommand {
  const parsed: ParsedNewCommand = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    if (arg === "--direct") {
      parsed.mode = "direct";
    } else if (arg === "--worktree") {
      parsed.mode = "worktree";
    } else if (arg === "--resume") {
      const resume = args[index + 1];
      if (!resume) throw new Error("/new --resume requires a worktree path or session id.");
      parsed.resume = resume;
      index += 1;
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown /new option ${arg}.`);
    } else if (!parsed.path) {
      parsed.path = arg;
    } else {
      throw new Error(`Unexpected /new argument ${arg}.`);
    }
  }
  return parsed;
}

export function parseCloseCommand(args: string[]): ParsedCloseCommand {
  const parsed: ParsedCloseCommand = { force: false };
  for (const arg of args) {
    if (arg === "--force" || arg === "-f") parsed.force = true;
    else throw new Error(`Unknown /close option ${arg}.`);
  }
  return parsed;
}

export function parseTunnelCommand(args: string[]): ParsedTunnelCommand {
  const action = args[0] ?? "status";
  if (args.length > 1) throw new Error("/tunnel accepts at most one action.");
  if (action !== "start" && action !== "stop" && action !== "status") {
    throw new Error("/tunnel action must be start, stop, or status.");
  }
  return { action };
}

export function findSlashCommand(name: string): SlashCommand | undefined {
  const normalized = name.toLowerCase();
  return slashCommands.find((command) => command.name === normalized || command.aliases?.includes(normalized));
}

export function suggestSlashCommands(input: string, limit = 6): SlashCommand[] {
  if (!input.startsWith("/")) return [];
  const parsed = parseSlashCommand(input);
  const query = (parsed?.name ?? input.slice(1)).toLowerCase();
  if (!query) return slashCommands.slice(0, limit);
  return slashCommands
    .filter((command) => command.name.includes(query) || command.aliases?.some((alias) => alias.includes(query)))
    .slice(0, limit);
}

function tokenizeArgs(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | "\"" | undefined;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index] ?? "";
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
    } else if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }
  if (quote) throw new Error("Unclosed quote in slash command.");
  if (current) tokens.push(current);
  return tokens;
}
