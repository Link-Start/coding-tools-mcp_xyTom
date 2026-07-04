import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server as NodeServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

export interface RegisteredHttpSession {
  sessionId: string;
  url: string;
}

interface SessionRoute {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

export class ConductorHttpServer {
  private readonly sessions = new Map<string, SessionRoute>();
  private server?: NodeServer;
  private port?: number;
  private bearerToken?: string;

  constructor(private readonly host = "127.0.0.1") {}

  get origin(): string | undefined {
    return this.port ? `http://${this.host}:${String(this.port)}` : undefined;
  }

  async listen(port = 0): Promise<string> {
    if (this.server && this.origin) return this.origin;
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
    await new Promise<void>((resolve, reject) => {
      const server = this.server;
      if (!server) return reject(new Error("HTTP server was not created."));
      server.once("error", reject);
      server.listen(port, this.host, () => {
        server.off("error", reject);
        const address = server.address() as AddressInfo | null;
        this.port = address?.port;
        resolve();
      });
    });
    if (!this.origin) throw new Error("HTTP server started without a port.");
    return this.origin;
  }

  async registerSession(sessionId: string, server: McpServer): Promise<RegisteredHttpSession> {
    if (!this.origin) await this.listen();
    await this.unregisterSession(sessionId);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
    await server.connect(transport);
    this.sessions.set(sessionId, { server, transport });
    return { sessionId, url: this.sessionUrl(sessionId) };
  }

  async unregisterSession(sessionId: string): Promise<void> {
    const route = this.sessions.get(sessionId);
    if (!route) return;
    this.sessions.delete(sessionId);
    await route.transport.close().catch(() => undefined);
  }

  sessionUrl(sessionId: string): string {
    if (!this.origin) throw new Error("HTTP server is not listening.");
    return `${this.origin}/mcp/${encodeURIComponent(sessionId)}`;
  }

  setBearerToken(token: string | undefined): void {
    this.bearerToken = token;
  }

  async close(): Promise<void> {
    const routes = [...this.sessions.keys()];
    await Promise.all(routes.map((sessionId) => this.unregisterSession(sessionId)));
    const server = this.server;
    this.server = undefined;
    this.port = undefined;
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.origin ?? `http://${this.host}`);
    const match = /^\/mcp\/([^/]+)$/.exec(url.pathname);
    if (!match) {
      sendText(res, 404, "Unknown ctc MCP route.");
      return;
    }
    if (!this.isAuthorized(req)) {
      sendText(res, 401, "Missing or invalid bearer token.", { "WWW-Authenticate": "Bearer" });
      return;
    }
    const sessionId = decodeURIComponent(match[1] ?? "");
    const route = this.sessions.get(sessionId);
    if (!route) {
      sendText(res, 404, `Unknown ctc session ${sessionId}.`);
      return;
    }
    if (req.method !== "GET" && req.method !== "POST" && req.method !== "DELETE") {
      sendText(res, 405, "Method not allowed.");
      return;
    }
    await route.transport.handleRequest(req, res);
  }

  private isAuthorized(req: IncomingMessage): boolean {
    if (!this.bearerToken) return true;
    return req.headers.authorization === `Bearer ${this.bearerToken}`;
  }
}

function sendText(res: ServerResponse, status: number, text: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", ...headers });
  res.end(`${text}\n`);
}
