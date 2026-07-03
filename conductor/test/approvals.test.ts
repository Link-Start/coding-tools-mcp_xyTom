import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createApprovalRequest,
  isTuiAttached,
  listPendingApprovals,
  markTuiAttached,
  respondToApproval,
  waitForApproval,
} from "../src/shared/approvals.js";

describe("approval coordination", () => {
  it("detects an attached TUI and resolves permission decisions", async () => {
    process.env.CTC_HOME = await mkdtemp(join(tmpdir(), "ctc-home-"));
    const sessionId = "approval-session";

    await expect(isTuiAttached(sessionId)).resolves.toBe(false);
    await markTuiAttached(sessionId);
    await expect(isTuiAttached(sessionId)).resolves.toBe(true);

    const request = await createApprovalRequest(sessionId, "{\"permission\":\"network\"}", { permission: "network" });
    await expect(listPendingApprovals(sessionId)).resolves.toHaveLength(1);

    await respondToApproval(sessionId, request.id, true);
    await expect(waitForApproval(sessionId, request.id, 100)).resolves.toBe("approved");
    await expect(listPendingApprovals(sessionId)).resolves.toHaveLength(0);
  });
});
