import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { ConductorHttpServer } from "../src/server/http.js";

let http: ConductorHttpServer | undefined;

afterEach(async () => {
  await http?.close();
  http = undefined;
});

describe("ConductorHttpServer", () => {
  it("routes MCP clients by session id", async () => {
    http = new ConductorHttpServer();
    await http.listen();
    const registered = await http.registerSession("session-a", createListToolsServer());
    const client = new Client({ name: "ctc-test", version: "0.1.0" }, { capabilities: {} });

    await client.connect(new StreamableHTTPClientTransport(new URL(registered.url)));
    await expect(client.listTools()).resolves.toEqual({ tools: [] });
    await client.close();
  });

  it("rejects unauthenticated requests when bearer auth is enabled", async () => {
    http = new ConductorHttpServer();
    await http.listen();
    const registered = await http.registerSession("session-a", createListToolsServer());
    http.setBearerToken("secret-token");

    const response = await fetch(registered.url, { method: "GET" });
    expect(response.status).toBe(401);
  });
});

function createListToolsServer(): Server {
  const server = new Server({ name: "ctc-test", version: "0.1.0" }, { capabilities: { tools: { listChanged: false } } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [] }));
  return server;
}
