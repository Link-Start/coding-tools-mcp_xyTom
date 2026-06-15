# Coding Tools MCP Control

A small Tauri desktop control panel for launching and checking a `coding-tools-mcp` server.

## What is covered

Core settings are first-class UI controls:

- Runner mode: bundled sidecar or external command
- External command: default `uvx coding-tools-mcp`
- Workspace path
- Transport: Streamable HTTP or stdio
- HTTP host and port
- Tool profile: `full`, `read-only`, `compat-readonly-all`
- Permission mode: `safe`, `trusted`, `dangerous`
- Shell environment inheritance: `core`, `all`, `none`
- `--allow-network`
- `--enable-view-image`
- Auth mode: local none, bearer, OAuth, remote noauth

Advanced settings stay editable without making the main surface too busy:

- `CODING_TOOLS_MCP_TRACE`
- `CODING_TOOLS_MCP_RUNTIME_ROOT`
- `CODING_TOOLS_MCP_SHELL_ENV_INCLUDE_ONLY`
- `CODING_TOOLS_MCP_SHELL_ENV_EXCLUDE`
- `CODING_TOOLS_MCP_SHELL_ENV_SET`
- `CODING_TOOLS_MCP_SERVER_URL`
- OAuth password, client id, client secret, token secret, token TTL
- Extra server arguments
- Extra environment variables
- `--dangerously-skip-all-permissions`

The app stores local preferences in the WebView's local storage. It does not require or invent a server config file.

## Bundled MCP sidecar

Packaged desktop builds include a `coding-tools-mcp` sidecar executable. The sidecar is frozen from the Python package with PyInstaller during the Tauri build, so end users do not need to install Python, uv, or `coding-tools-mcp` separately.

Developers still need uv and the normal Tauri toolchain to create packages. The build script uses uv to install the project plus the `image` extra, adds PyInstaller to that build environment, and writes the platform-specific executable to `src-tauri/binaries/coding-tools-mcp-$TARGET_TRIPLE` for Tauri to bundle.

Advanced users can switch the UI to External command mode and run their own command, for example `uvx coding-tools-mcp` or an absolute path to another server build.

For macOS signed builds, the PyInstaller sidecar must be signed with the same Apple Developer identity as the Tauri app. The build script automatically uses a real `APPLE_SIGNING_IDENTITY` value when present, or you can pass `--codesign-identity` / `PYINSTALLER_CODESIGN_IDENTITY` explicitly. The sidecar also uses `src-tauri/Sidecar.entitlements.plist` so the frozen Python runtime can load its bundled dynamic libraries under hardened runtime.

## Health checks

For HTTP transport the app checks:

- `GET /.well-known/mcp.json`
- `POST /mcp` with a JSON-RPC `ping`

Bearer mode sends the configured bearer token. OAuth mode treats an authenticated `401` from `/mcp` as a good protection signal, because the desktop app is not doing the OAuth browser flow itself.

Stdio mode can be launched, but health checks are intentionally disabled because there is no HTTP endpoint to probe.

## Run

Install dependencies and start the Tauri app:

```bash
npm install
npm run dev
```

`npm run dev` builds the local sidecar on first run and reuses it afterwards.

Build static web assets only:

```bash
npm run build:web
```

Run lightweight JavaScript checks:

```bash
npm run check
```

Build the desktop app:

```bash
npm run build
```

Build the sidecar only:

```bash
npm run build:sidecar
```

The desktop build requires uv, Rust, Node.js, and the native desktop development libraries required by Tauri for the target platform.
