import { createInterface } from "node:readline";
import { existsSync, writeFileSync } from "node:fs";

const statePath = process.argv[2];

const tools = [
  {
    name: "server_info",
    description: "fake server info",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "unstable",
    description: "exits once before succeeding",
    inputSchema: { type: "object", properties: {} },
  },
];

const lines = createInterface({ input: process.stdin });

lines.on("line", (line) => {
  if (!line.trim()) return;
  const request = JSON.parse(line);
  if (request.method === "notifications/initialized") return;
  if (request.method === "initialize") {
    send(request.id, { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fake", version: "0" } });
    return;
  }
  if (request.method === "tools/list") {
    send(request.id, { tools });
    return;
  }
  if (request.method === "tools/call") {
    const name = request.params?.name;
    if (name === "unstable" && statePath && !existsSync(statePath)) {
      writeFileSync(statePath, "failed-once", "utf8");
      process.exit(42);
    }
    send(request.id, { content: [{ type: "text", text: `${name}:ok` }], structuredContent: { ok: true }, isError: false });
  }
});

function send(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}
