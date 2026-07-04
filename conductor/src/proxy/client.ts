import { setTimeout as delay } from "node:timers/promises";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { BackendConfig, BackendStatus, CachedTool } from "../shared/types.js";

export class BackendDisconnectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackendDisconnectedError";
  }
}

export class BackendClient {
  private readonly backend: BackendConfig;
  private connection?: BackendConnection;
  private reconnecting = false;
  private lastError?: string;
  private cachedTools: CachedTool[] = [];

  constructor(backend: BackendConfig) {
    this.backend = backend;
  }

  status(): BackendStatus {
    return {
      connected: Boolean(this.connection),
      reconnecting: this.reconnecting,
      lastError: this.lastError,
    };
  }

  tools(): CachedTool[] {
    return this.cachedTools;
  }

  async start(): Promise<void> {
    await this.connectOnce();
    await this.refreshToolCache();
    await this.callTool("server_info", {});
  }

  async refreshToolCache(): Promise<CachedTool[]> {
    const connection = this.requireConnection();
    const response = await connection.listTools();
    this.cachedTools = response.tools;
    return this.cachedTools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const connection = this.connection;
    if (!connection) {
      this.scheduleReconnect();
      throw new BackendDisconnectedError(this.lastError ?? "Lower coding-tools-mcp backend is disconnected");
    }
    try {
      return await connection.callTool(name, args);
    } catch (error) {
      this.markDisconnected(error);
      this.scheduleReconnect();
      throw new BackendDisconnectedError(
        `Lower coding-tools-mcp backend call failed; reconnecting in background: ${errorMessage(error)}`,
      );
    }
  }

  async close(): Promise<void> {
    this.reconnecting = false;
    const connection = this.connection;
    this.connection = undefined;
    if (connection) await connection.close();
  }

  private async connectOnce(): Promise<void> {
    await this.close();
    const connection = this.createConnection();
    await connection.connect();
    this.connection = connection;
    this.lastError = undefined;
  }

  private createConnection(): BackendConnection {
    if (this.backend.type === "stdio") {
      return new LineDelimitedStdioBackendConnection(this.backend.command);
    }
    return new SdkHttpBackendConnection(this.backend.url, this.backend.tokenRef);
  }

  private requireConnection(): BackendConnection {
    if (!this.connection) throw new BackendDisconnectedError(this.lastError ?? "Lower backend is disconnected");
    return this.connection;
  }

  private markDisconnected(error: unknown): void {
    this.lastError = errorMessage(error);
    void this.close();
  }

  private scheduleReconnect(): void {
    if (this.reconnecting) return;
    this.reconnecting = true;
    void this.reconnectLoop();
  }

  private async reconnectLoop(): Promise<void> {
    let waitMs = 250;
    for (;;) {
      await delay(waitMs);
      if (!this.reconnecting) return;
      try {
        await this.connectOnce();
        await this.refreshToolCache();
        this.reconnecting = false;
        return;
      } catch (error) {
        this.lastError = errorMessage(error);
        waitMs = Math.min(waitMs * 2, 5000);
      }
    }
  }
}

interface BackendConnection {
  connect(): Promise<void>;
  listTools(): Promise<{ tools: CachedTool[] }>;
  callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
  close(): Promise<void>;
}

class SdkHttpBackendConnection implements BackendConnection {
  private readonly url: string;
  private readonly tokenRef: string | undefined;
  private client?: Client;

  constructor(url: string, tokenRef: string | undefined) {
    this.url = url;
    this.tokenRef = tokenRef;
  }

  async connect(): Promise<void> {
    const headers = bearerHeaders(this.tokenRef);
    const transport = new StreamableHTTPClientTransport(new URL(this.url), {
      requestInit: Object.keys(headers).length > 0 ? { headers } : undefined,
    });
    const client = new Client({ name: "coding-tools-conductor", version: "0.1.0" }, { capabilities: {} });
    await client.connect(transport);
    this.client = client;
  }

  async listTools(): Promise<{ tools: CachedTool[] }> {
    return this.requireClient().listTools();
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    return (await this.requireClient().callTool({ name, arguments: args })) as CallToolResult;
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    if (client) await client.close();
  }

  private requireClient(): Client {
    if (!this.client) throw new BackendDisconnectedError("HTTP backend is disconnected");
    return this.client;
  }
}

class LineDelimitedStdioBackendConnection implements BackendConnection {
  private readonly command: string[];
  private process?: ChildProcessWithoutNullStreams;
  private lines?: Interface;
  private nextId = 1;
  private stderrTail = "";
  private closedError?: Error;
  private pending = new Map<number, PendingRequest>();

  constructor(command: string[]) {
    this.command = command;
  }

  async connect(): Promise<void> {
    const [command, ...args] = this.command;
    if (!command) throw new Error("stdio backend command is empty");
    const child = spawn(command, args, { stdio: "pipe", env: process.env });
    this.process = child;
    this.closedError = undefined;
    this.lines = createInterface({ input: child.stdout });
    this.lines.on("line", (line) => {
      this.handleLine(line);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderrTail = `${this.stderrTail}${chunk.toString("utf8")}`.slice(-4000);
    });
    child.once("error", (error) => {
      this.markClosed(new BackendDisconnectedError(`stdio backend failed to start: ${errorMessage(error)}`));
    });
    child.once("exit", () => {
      this.markClosed(new BackendDisconnectedError(this.closeMessage()));
    });
    try {
      await this.request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "coding-tools-conductor", version: "0.1.0" },
      });
      this.notify("notifications/initialized", {});
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async listTools(): Promise<{ tools: CachedTool[] }> {
    return (await this.request("tools/list", {})) as { tools: CachedTool[] };
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    return (await this.request("tools/call", { name, arguments: args })) as CallToolResult;
  }

  close(): Promise<void> {
    this.lines?.close();
    this.lines = undefined;
    const child = this.process;
    this.process = undefined;
    this.markClosed(new BackendDisconnectedError("stdio backend connection closed"));
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    return Promise.resolve();
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const child = this.process;
    if (this.closedError) return Promise.reject(this.closedError);
    if (!child?.stdin.writable) return Promise.reject(new BackendDisconnectedError(this.closeMessage()));
    const id = this.nextId++;
    const request = { jsonrpc: "2.0", id, method, params };
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    child.stdin.write(`${JSON.stringify(request)}\n`);
    return promise;
  }

  private notify(method: string, params: Record<string, unknown>): void {
    const child = this.process;
    if (!child?.stdin.writable) return;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let message: JsonRpcResponse;
    try {
      message = JSON.parse(line) as JsonRpcResponse;
    } catch (error) {
      this.rejectAll(new Error(`Invalid JSON-RPC from backend: ${errorMessage(error)}`));
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(new Error(message.error.message));
    } else {
      pending.resolve(message.result);
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private markClosed(error: Error): void {
    this.closedError = error;
    this.rejectAll(error);
  }

  private closeMessage(): string {
    return this.stderrTail ? `stdio backend closed: ${this.stderrTail}` : "stdio backend closed";
  }
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

interface JsonRpcResponse {
  id?: number;
  result?: unknown;
  error?: { message: string };
}

function bearerHeaders(tokenRef: string | undefined): Record<string, string> {
  if (!tokenRef) return {};
  if (!tokenRef.startsWith("env:")) throw new Error("Only env:<NAME> token references are supported");
  const envName = tokenRef.slice("env:".length);
  const token = process.env[envName];
  if (!token) throw new Error(`Token env var ${envName} is not set`);
  return { Authorization: `Bearer ${token}` };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
