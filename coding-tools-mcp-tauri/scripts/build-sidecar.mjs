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
const defaultEntitlementsPath = path.join(srcTauriDir, "Sidecar.entitlements.plist");
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

const pyinstallerArgs = [
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
  repoRoot
];

const macSigning = macSigningOptions(options);
if (macSigning.codesignIdentity) {
  pyinstallerArgs.push("--codesign-identity", macSigning.codesignIdentity);
}
if (macSigning.entitlementsFile) {
  pyinstallerArgs.push("--osx-entitlements-file", macSigning.entitlementsFile);
}
pyinstallerArgs.push(entryPath);

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
  ...pyinstallerArgs
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
  const parsed = {
    allowCrossName: false,
    codesignIdentity: "",
    entitlements: "",
    skipIfExists: false,
    target: ""
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--allow-cross-name") {
      parsed.allowCrossName = true;
    } else if (arg === "--codesign-identity") {
      parsed.codesignIdentity = args[++index] || "";
    } else if (arg.startsWith("--codesign-identity=")) {
      parsed.codesignIdentity = arg.slice("--codesign-identity=".length);
    } else if (arg === "--entitlements" || arg === "--osx-entitlements-file") {
      parsed.entitlements = args[++index] || "";
    } else if (arg.startsWith("--entitlements=")) {
      parsed.entitlements = arg.slice("--entitlements=".length);
    } else if (arg.startsWith("--osx-entitlements-file=")) {
      parsed.entitlements = arg.slice("--osx-entitlements-file=".length);
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

function macSigningOptions(parsed) {
  if (process.platform !== "darwin") {
    return { codesignIdentity: "", entitlementsFile: "" };
  }

  const explicitIdentity = parsed.codesignIdentity.trim();
  const pyinstallerIdentity = (process.env.PYINSTALLER_CODESIGN_IDENTITY || "").trim();
  const appleIdentity = (process.env.APPLE_SIGNING_IDENTITY || "").trim();
  const codesignIdentity = explicitIdentity || pyinstallerIdentity || realSigningIdentity(appleIdentity);
  const entitlementsFile = resolveEntitlementsFile(parsed.entitlements);

  if (codesignIdentity) {
    console.log(`macOS sidecar codesign identity: ${codesignIdentity}`);
  } else {
    console.log("macOS sidecar codesign identity: PyInstaller default ad-hoc");
  }
  if (entitlementsFile) {
    console.log(`macOS sidecar entitlements: ${path.relative(appDir, entitlementsFile)}`);
  }

  return { codesignIdentity, entitlementsFile };
}

function realSigningIdentity(identity) {
  return identity && identity !== "-" ? identity : "";
}

function resolveEntitlementsFile(value) {
  const explicit = value.trim() || (process.env.PYINSTALLER_ENTITLEMENTS_FILE || "").trim();
  const candidate = explicit || defaultEntitlementsPath;
  const resolved = path.isAbsolute(candidate) ? candidate : path.resolve(appDir, candidate);
  if (!existsSync(resolved)) {
    if (explicit) {
      throw new Error(`macOS sidecar entitlements file does not exist: ${resolved}`);
    }
    return "";
  }
  return resolved;
}

function hostTriple() {
  const direct = spawnSync("rustc", ["--print", "host-tuple"], { encoding: "utf8" });
  if (direct.status === 0 && direct.stdout.trim()) {
    return direct.stdout.trim();
  }
  const verbose = spawnSync("rustc", ["-Vv"], { encoding: "utf8" });
  if (verbose.status !== 0) {
    const fallback = nodeHostTriple();
    if (fallback) {
      return fallback;
    }
    const detail = verbose.error?.message || direct.error?.message || verbose.stderr || direct.stderr || "unknown error";
    throw new Error(`failed to determine Rust host triple: ${detail}`);
  }
  const match = verbose.stdout.match(/^host:\s*(\S+)$/m);
  if (!match) {
    throw new Error("failed to find host triple in rustc -Vv output");
  }
  return match[1];
}

function nodeHostTriple() {
  const triples = {
    "darwin:arm64": "aarch64-apple-darwin",
    "darwin:x64": "x86_64-apple-darwin",
    "linux:arm64": "aarch64-unknown-linux-gnu",
    "linux:x64": "x86_64-unknown-linux-gnu",
    "win32:arm64": "aarch64-pc-windows-msvc",
    "win32:x64": "x86_64-pc-windows-msvc"
  };
  return triples[`${process.platform}:${process.arch}`] || "";
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
