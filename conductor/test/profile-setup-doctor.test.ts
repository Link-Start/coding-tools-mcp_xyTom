import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runDoctor } from "../src/cli/doctor.js";
import { runSetupCli } from "../src/cli/setup.js";
import { readProfileForPath, resolveRuntimeOptions, writeProfileForPath } from "../src/profiles/config.js";
import type { WorkspaceProfile } from "../src/shared/types.js";
import { createGitRepo } from "./git-fixtures.js";

describe("profile setup and doctor", () => {
  it("writes and reads workspace profiles", async () => {
    const repo = await createGitRepo("ctc-profile-");
    process.env.CTC_HOME = await mkdtemp(join(tmpdir(), "ctc-home-"));
    const profile: WorkspaceProfile = {
      repoPath: repo,
      backend: { type: "http", url: "http://127.0.0.1:1/mcp", tokenRef: "env:CTC_TEST_TOKEN" },
      defaultMode: "worktree",
      toolPolicy: { deny: ["kill_session"] },
      tunnel: { provider: "none" },
      adapters: ["chatgpt"],
    };

    await writeProfileForPath(repo, profile);
    await expect(readProfileForPath(repo)).resolves.toMatchObject(profile);
    await expect(resolveRuntimeOptions({ path: repo })).resolves.toMatchObject({ adapters: ["chatgpt"] });
  });

  it("configures a profile from non-interactive setup options and diagnoses it", async () => {
    const repo = await createGitRepo("ctc-setup-");
    process.env.CTC_HOME = await mkdtemp(join(tmpdir(), "ctc-home-"));
    process.env.CTC_TEST_TOKEN = "test-token";

    await runSetupCli(repo, {
      yes: true,
      skipSmoke: true,
      backend: "http",
      backendUrl: "http://127.0.0.1:1/mcp",
      backendTokenEnv: "CTC_TEST_TOKEN",
      defaultMode: "direct",
      deny: ["kill_session"],
      tunnel: "none",
      adapter: ["chatgpt"],
    });

    await expect(readProfileForPath(repo)).resolves.toMatchObject({
      repoPath: repo,
      backend: { type: "http", url: "http://127.0.0.1:1/mcp", tokenRef: "env:CTC_TEST_TOKEN" },
      defaultMode: "direct",
      toolPolicy: { deny: ["kill_session"] },
      adapters: ["chatgpt"],
    });

    const checks = await runDoctor(repo, { skipBackend: true });
    expect(checks).toContainEqual(expect.objectContaining({ name: "profile", status: "pass" }));
    expect(checks).toContainEqual(expect.objectContaining({ name: "token", status: "pass" }));
    expect(checks).toContainEqual(expect.objectContaining({ name: "backend", status: "warn" }));
  });
});
