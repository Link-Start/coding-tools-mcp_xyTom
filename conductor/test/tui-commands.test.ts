import { describe, expect, it } from "vitest";
import {
  findSlashCommand,
  parseCloseCommand,
  parseNewCommand,
  parseSlashCommand,
  parseTunnelCommand,
  suggestSlashCommands,
} from "../src/tui/commands/registry.js";

describe("TUI slash command registry", () => {
  it("parses slash commands with arguments", () => {
    expect(parseSlashCommand("/switch 2")).toEqual({ raw: "/switch 2", name: "switch", args: ["2"] });
    expect(parseSlashCommand('/new "path with spaces" --worktree')).toEqual({
      raw: '/new "path with spaces" --worktree',
      name: "new",
      args: ["path with spaces", "--worktree"],
    });
    expect(parseSlashCommand("plain text")).toBeUndefined();
  });

  it("parses workspace slash command options", () => {
    expect(parseNewCommand(["/repo/api", "--worktree"])).toEqual({ path: "/repo/api", mode: "worktree" });
    expect(parseNewCommand(["--resume", "session-a"])).toEqual({ resume: "session-a" });
    expect(parseCloseCommand(["--force"])).toEqual({ force: true });
    expect(parseTunnelCommand(["start"])).toEqual({ action: "start" });
    expect(parseTunnelCommand([])).toEqual({ action: "status" });
  });

  it("rejects malformed slash command arguments", () => {
    expect(() => parseSlashCommand('/new "unterminated')).toThrow(/Unclosed quote/);
    expect(() => parseNewCommand(["--bogus"])).toThrow(/Unknown \/new option/);
    expect(() => parseCloseCommand(["--bogus"])).toThrow(/Unknown \/close option/);
    expect(() => parseTunnelCommand(["restart"])).toThrow(/action must be/);
  });

  it("resolves aliases and suggestions", () => {
    expect(findSlashCommand("?")?.name).toBe("help");
    expect(findSlashCommand("tunnel")?.stage).toBe("available");
    expect(suggestSlashCommands("/sw").map((command) => command.name)).toContain("switch");
  });
});
