import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { LoadedSkill, SkillSummary, WorkspaceContextGuide } from "../shared/types.js";

const INSTRUCTION_FILENAMES = new Set(["AGENTS.md", "CLAUDE.md", ".cursorrules"]);
const SKIPPED_DIRS = new Set([".git", "node_modules", "dist", "coverage", ".ctc-smoke"]);
const INSTRUCTION_INLINE_BYTES = 16 * 1024;
const MAX_SCAN_ENTRIES = 10_000;

const SKILL_ROOTS = [
  { path: [".ctc", "skills"], source: "ctc" as const },
  { path: [".claude", "skills"], source: "claude" as const },
];

export async function discoverWorkspaceContext(rootPath: string): Promise<WorkspaceContextGuide> {
  const root = resolve(rootPath);
  const instructionFiles = await discoverInstructionFiles(root);
  const skills = await discoverSkills(root);
  return { rootPath: root, instructionFiles, skills };
}

export async function loadWorkspaceSkill(rootPath: string, name: string): Promise<LoadedSkill> {
  if (!isSafeSkillName(name)) throw new Error(`Invalid skill name ${name}`);
  const root = resolve(rootPath);
  for (const skillRoot of SKILL_ROOTS) {
    const skillFile = join(root, ...skillRoot.path, name, "SKILL.md");
    if (!existsSync(skillFile)) continue;
    const content = await readFile(skillFile, "utf8");
    return {
      name,
      path: toRelativePath(root, skillFile),
      source: skillRoot.source,
      description: parseFrontmatterDescription(content),
      content,
    };
  }
  throw new Error(`Skill ${name} was not found under .ctc/skills or .claude/skills.`);
}

async function discoverInstructionFiles(root: string): Promise<WorkspaceContextGuide["instructionFiles"]> {
  const files: WorkspaceContextGuide["instructionFiles"] = [];
  let scanned = 0;

  async function visit(dir: string): Promise<void> {
    if (scanned >= MAX_SCAN_ENTRIES) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      scanned += 1;
      if (scanned >= MAX_SCAN_ENTRIES) return;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) await visit(fullPath);
        continue;
      }
      if (!entry.isFile() || !INSTRUCTION_FILENAMES.has(entry.name)) continue;
      const info = await stat(fullPath);
      const rootLevel = dirname(fullPath) === root;
      const summary = {
        path: toRelativePath(root, fullPath),
        bytes: info.size,
        rootLevel,
      };
      if (!rootLevel) {
        files.push(summary);
        continue;
      }
      files.push({ ...summary, ...(await readInlineInstruction(fullPath, info.size)) });
    }
  }

  await visit(root);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function readInlineInstruction(path: string, bytes: number): Promise<{ inlineContent: string; truncated: boolean }> {
  const content = await readFile(path, "utf8");
  if (bytes <= INSTRUCTION_INLINE_BYTES) return { inlineContent: content, truncated: false };
  let snippet = content;
  while (Buffer.byteLength(snippet, "utf8") > INSTRUCTION_INLINE_BYTES) snippet = snippet.slice(0, -1);
  return { inlineContent: snippet, truncated: true };
}

async function discoverSkills(root: string): Promise<SkillSummary[]> {
  const skills = new Map<string, SkillSummary>();
  for (const skillRoot of SKILL_ROOTS) {
    const rootDir = join(root, ...skillRoot.path);
    if (!existsSync(rootDir)) continue;
    let entries;
    try {
      entries = await readdir(rootDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !isSafeSkillName(entry.name)) continue;
      const skillFile = join(rootDir, entry.name, "SKILL.md");
      if (!existsSync(skillFile) || skills.has(entry.name)) continue;
      const content = await readFile(skillFile, "utf8");
      skills.set(entry.name, {
        name: entry.name,
        path: toRelativePath(root, skillFile),
        source: skillRoot.source,
        description: parseFrontmatterDescription(content),
      });
    }
  }
  return [...skills.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function parseFrontmatterDescription(content: string): string | undefined {
  if (!content.startsWith("---")) return undefined;
  const end = content.indexOf("\n---", 3);
  if (end === -1) return undefined;
  const frontmatter = content.slice(3, end).split(/\r?\n/u);
  for (const line of frontmatter) {
    const match = /^description\s*:\s*(.+)$/iu.exec(line.trim());
    if (!match?.[1]) continue;
    return stripYamlString(match[1]);
  }
  return undefined;
}

function stripYamlString(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function isSafeSkillName(name: string): boolean {
  return /^[A-Za-z0-9._-]+$/u.test(name) && name !== "." && name !== ".." && basename(name) === name;
}

function toRelativePath(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}
