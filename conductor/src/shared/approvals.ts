import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { ctcHome } from "../profiles/config.js";

export type ApprovalStatus = "pending" | "approved" | "denied" | "timeout";

export interface PermissionApprovalRequest {
  id: string;
  sessionId: string;
  status: ApprovalStatus;
  createdAt: string;
  updatedAt: string;
  argsSummary: string;
  args: Record<string, unknown>;
}

const attachFreshMs = 5_000;
const pollMs = 500;

const approvalSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  status: z.enum(["pending", "approved", "denied", "timeout"]),
  createdAt: z.string(),
  updatedAt: z.string(),
  argsSummary: z.string(),
  args: z.record(z.unknown()),
});

export async function markTuiAttached(sessionId: string): Promise<void> {
  await mkdir(approvalDir(sessionId), { recursive: true });
  await writeFile(
    join(approvalDir(sessionId), "attached.json"),
    `${JSON.stringify({ sessionId, pid: process.pid, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    "utf8",
  );
}

export async function isTuiAttached(sessionId: string): Promise<boolean> {
  const path = join(approvalDir(sessionId), "attached.json");
  if (!existsSync(path)) return false;
  const parsed = z.object({ updatedAt: z.string() }).parse(JSON.parse(await readFile(path, "utf8")));
  return Date.now() - Date.parse(parsed.updatedAt) <= attachFreshMs;
}

export async function createApprovalRequest(
  sessionId: string,
  argsSummary: string,
  args: Record<string, unknown>,
): Promise<PermissionApprovalRequest> {
  const now = new Date().toISOString();
  const request: PermissionApprovalRequest = {
    id: randomUUID(),
    sessionId,
    status: "pending",
    createdAt: now,
    updatedAt: now,
    argsSummary,
    args,
  };
  await writeApprovalRequest(request);
  return request;
}

export async function waitForApproval(
  sessionId: string,
  requestId: string,
  timeoutMs = 10 * 60 * 1000,
): Promise<ApprovalStatus> {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    const request = await readApprovalRequest(sessionId, requestId).catch(() => undefined);
    if (request?.status === "approved" || request?.status === "denied") return request.status;
    await delay(pollMs);
  }
  await updateApprovalStatus(sessionId, requestId, "timeout").catch(() => undefined);
  return "timeout";
}

export async function listPendingApprovals(sessionId: string): Promise<PermissionApprovalRequest[]> {
  const dir = approvalDir(sessionId);
  if (!existsSync(dir)) return [];
  const names = await readdir(dir);
  const requests = await Promise.all(
    names
      .filter((name) => name.endsWith(".json") && name !== "attached.json")
      .map(async (name) => readApprovalRequest(sessionId, name.slice(0, -".json".length)).catch(() => undefined)),
  );
  return requests
    .filter((request): request is PermissionApprovalRequest => request?.status === "pending")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function respondToApproval(sessionId: string, requestId: string, approved: boolean): Promise<void> {
  await updateApprovalStatus(sessionId, requestId, approved ? "approved" : "denied");
}

async function updateApprovalStatus(sessionId: string, requestId: string, status: ApprovalStatus): Promise<void> {
  const request = await readApprovalRequest(sessionId, requestId);
  await writeApprovalRequest({ ...request, status, updatedAt: new Date().toISOString() });
}

async function readApprovalRequest(sessionId: string, requestId: string): Promise<PermissionApprovalRequest> {
  return approvalSchema.parse(JSON.parse(await readFile(approvalPath(sessionId, requestId), "utf8")));
}

async function writeApprovalRequest(request: PermissionApprovalRequest): Promise<void> {
  await mkdir(approvalDir(request.sessionId), { recursive: true });
  await writeFile(approvalPath(request.sessionId, request.id), `${JSON.stringify(request, null, 2)}\n`, "utf8");
}

function approvalDir(sessionId: string): string {
  return join(ctcHome(), "approvals", sessionId);
}

function approvalPath(sessionId: string, requestId: string): string {
  return join(approvalDir(sessionId), `${requestId}.json`);
}
