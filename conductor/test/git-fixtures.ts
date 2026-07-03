import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";

export async function createGitRepo(prefix: string): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), prefix));
  await execa("git", ["init"], { cwd: repo });
  await execa("git", ["config", "user.name", "ctc test"], { cwd: repo });
  await execa("git", ["config", "user.email", "ctc@example.invalid"], { cwd: repo });
  await writeFile(join(repo, "a.txt"), "base\n", "utf8");
  await execa("git", ["add", "a.txt"], { cwd: repo });
  await execa("git", ["commit", "-m", "initial"], { cwd: repo });
  return repo;
}

export async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await execa("git", args, { cwd: repo });
  return stdout;
}
