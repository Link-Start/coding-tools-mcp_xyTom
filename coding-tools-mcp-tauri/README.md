# Coding Tools MCP Control

A small Tauri desktop control panel for launching and checking a `coding-tools-mcp` server.

## What is covered

Core settings are first-class UI controls:

- Server command: default `uvx coding-tools-mcp`
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

The desktop build requires a normal Tauri/Rust toolchain plus the native Linux desktop development libraries used by Tauri. In this remote MCP workspace, Rust/Cargo were installed locally for validation, but the full Linux package build currently stops because `pkg-config` cannot find `gdk-3.0.pc`. That must be provided by the host image or installed as a system package before the final Tauri bundle can complete.
