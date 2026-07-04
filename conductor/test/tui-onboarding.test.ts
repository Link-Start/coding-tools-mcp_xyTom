import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readProfileForPath } from "../src/profiles/config.js";
import { advanceOnboarding, loadOnboardingState } from "../src/tui/onboarding.js";

describe("TUI onboarding", () => {
  it("writes a default profile after accepting the three defaults", async () => {
    const home = await mkdtemp(join(tmpdir(), "ctc-onboarding-home-"));
    const repo = await mkdtemp(join(tmpdir(), "ctc-onboarding-repo-"));
    process.env.CTC_HOME = home;

    const first = await loadOnboardingState(repo);
    expect(first?.step).toBe("backend");
    if (!first) throw new Error("Expected onboarding to be required.");

    const second = await advanceOnboarding(first, "");
    expect(second.step).toBe("workspace");

    const third = await advanceOnboarding(second, "");
    expect(third.step).toBe("permissions");

    const complete = await advanceOnboarding(third, "");
    expect(complete.complete).toBe(true);

    const profile = await readProfileForPath(repo);
    expect(profile?.backend.type).toBe("stdio");
    expect(profile?.defaultMode).toBe("worktree");
    expect(profile?.permissionMode).toBe("safe");
    await expect(loadOnboardingState(repo)).resolves.toBeUndefined();
  });
});
