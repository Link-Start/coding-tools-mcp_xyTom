import { mkdir, appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ConductorEvent } from "./types.js";

export class JsonlEventLog {
  readonly path: string;
  readonly conciseLogs: boolean;

  constructor(path: string, conciseLogs: boolean) {
    this.path = path;
    this.conciseLogs = conciseLogs;
  }

  async append(event: ConductorEvent): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(event)}\n`, "utf8");
    if (this.conciseLogs && event.type === "tool_call") {
      const status = event.error ? "x" : "ok";
      const detail = event.error ? ` ${event.error}` : "";
      process.stderr.write(`[ctc] ${event.tool} ${status} ${String(event.durationMs)}ms${detail}\n`);
    }
  }
}
