import { copyFileSync, chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(appDir, "..");
const srcTauriDir = path.join(appDir, "src-tauri");
const binariesDir = path.join(srcTauriDir, "binaries");
const entryPath = path.join(appDir, "sidecar", "coding_tools_mcp_sidecar.py");
const buildRoot = path.join(appDir, ".sidecar-build");
const distDir = path.join(buildRoot, "dist");
const workDir = path.join(buildRoot, "work");
const specDir = path.join(buildRoot, "spec");
const sidecarBase = "coding-tools-mcp";

const options = parseArgs(process.argv.slice(2));
const targetTriple = options.target || process.env.TAURI_SIDECAR_TARGET_TRIPLE || process.env.TAURI_BUILD_TARGET || hostTriple();
const host = hostTriple();

if (!options.allowCrossName && targetTriple !== host) {
  throw new Error(
    `PyInstaller cannot cross-freeze Python apps safely. Host triple is ${host}, requested ${targetTriple}. ` +
      "Use a runner with the requested architecture or pass --allow-cross-name only for a deliberate local experiment."
  );
}

const extension = process.platform === "win32" ? ".exe" : "";
const pyinstallerOutput = path.join(distDir, `${sidecarBase}${extension}`);
const tauriSidecar = path.join(binariesDir, `${sidecarBase}-${targetTriple}${extension}`);

if (options.skipIfExists && existsSync(tauriSidecar)) {
  probeSidecar(tauriSidecar);
  console.log(`sidecar already exists: ${path.relative(appDir, tauriSidecar)}`);
  process.exit(0);
}

mkdirSync(binariesDir, { recursive: true });
rmSync(buildRoot, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });
mkdirSync(workDir, { recursive: true });
mkdirSync(specDir, { recursive: true });

run("uv", [
  "run",
  "--managed-python",
  "--python",
  "3.12",
  "--project",
  repoRoot,
  "--extra",
  "image",
  "--with",
  "pyinstaller>=6.0",
  "--",
  "pyinstaller",
  "--clean",
  "--noconfirm",
  "--onefile",
  "--name",
  sidecarBase,
  "--distpath",
  distDir,
  "--workpath",
  workDir,
  "--specpath",
  specDir,
  "--paths",
  repoRoot,
  entryPath
], { cwd: repoRoot, env: { ...process.env, UV_LINK_MODE: process.env.UV_LINK_MODE || "copy" } });

if (!existsSync(pyinstallerOutput)) {
  throw new Error(`PyInstaller did not create ${pyinstallerOutput}`);
}

copyFileSync(pyinstallerOutput, tauriSidecar);
if (process.platform !== "win32") {
  chmodSync(tauriSidecar, 0o755);
}

probeSidecar(tauriSidecar);
console.log(`built sidecar: ${path.relative(appDir, tauriSidecar)}`);

function parseArgs(args) {
  const parsed = { allowCrossName: false, skipIfExists: false, target: "" };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--allow-cross-name") {
      parsed.allowCrossName = true;
    } else if (arg === "--skip-if-exists") {
      parsed.skipIfExists = true;
    } else if (arg === "--target") {
      parsed.target = args[++index] || "";
    } else if (arg.startsWith("--target=")) {
      parsed.target = arg.slice("--target=".length);
    } else {
      throw new Error(`Unknown sidecar build argument: ${arg}`);
    }
  }
  return parsed;
}

function hostTriple() {
  const direct = spawnSync("rustc", ["--print", "host-tuple"], { encoding: "utf8" });
  if (direct.status === 0 && direct.stdout.trim()) {
    return direct.stdout.trim();
  }
  const verbose = spawnSync("rustc", ["-Vv"], { encoding: "utf8" });
  if (verbose.status !== 0) {
    throw new Error(`failed to determine Rust host triple: ${verbose.stderr || direct.stderr}`);
  }
  const match = verbose.stdout.match(/^host:\s*(\S+)$/m);
  if (!match) {
    throw new Error("failed to find host triple in rustc -Vv output");
  }
  return match[1];
}

function run(command, args, opts) {
  const result = spawnSync(command, args, { ...opts, stdio: "inherit" });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`);
  }
}

function probeSidecar(executable) {
  const result = spawnSync(executable, ["--help"], { encoding: "utf8" });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`sidecar smoke test failed with status ${result.status}${output ? `:\n${output}` : ""}`);
  }
}
