import { execa } from "execa";

export async function resolveGitRoot(path: string): Promise<string | undefined> {
  try {
    const { stdout } = await execa("git", ["-C", path, "rev-parse", "--show-toplevel"]);
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}
