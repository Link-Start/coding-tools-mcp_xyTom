const STORAGE_KEY = "coding-tools-mcp-control:v1";

const defaultConfig = {
  runnerMode: "bundled",
  serverCommand: "uvx coding-tools-mcp",
  workspace: "",
  transport: "http",
  host: "127.0.0.1",
  port: 8000,
  toolProfile: "full",
  permissionMode: "safe",
  shellEnvInherit: "core",
  allowNetwork: false,
  enableViewImage: true,
  trace: false,
  authMode: "none",
  authToken: "",
  oauthPassword: "",
  oauthClientId: "",
  oauthClientSecret: "",
  oauthTokenSecret: "",
  oauthTokenTtl: "2592000",
  serverUrl: "",
  runtimeRoot: "",
  envIncludeOnly: "",
  envExclude: "",
  envSetJson: "",
  dangerouslySkipAllPermissions: false,
  extraArgs: "",
  extraEnv: [{ key: "", value: "", enabled: true }]
};

const toolProfiles = [
  ["full", "Full", "All tools, including edit and command execution."],
  ["read-only", "Read only", "Inspection tools and git read tools."],
  ["compat-readonly-all", "Compat", "All tools advertised as read-only for client compatibility."]
];

const permissionModes = [
  ["safe", "Safe", "No network, shell expansion, or inline scripts."],
  ["trusted", "Trusted", "Local development mode with network and inline scripts."],
  ["dangerous", "Dangerous", "No command permission gates or Landlock."]
];

const shellModes = [
  ["core", "Core env"],
  ["all", "All env"],
  ["none", "No inherited env"]
];

const authModes = [
  ["none", "Local none"],
  ["bearer", "Bearer"],
  ["oauth", "OAuth"],
  ["noauth", "Remote noauth"]
];

const runnerModes = [
  ["bundled", "Bundled", "Use the MCP executable packaged with this desktop app."],
  ["external", "External", "Run a custom command such as uvx coding-tools-mcp."]
];

let config = loadConfig();
let runtime = { running: false, pid: null };
let health = null;
let logs = [];
let busy = "";
let toast = "";

const app = document.querySelector("#app");
const invoke = window.__TAURI__?.core?.invoke?.bind(window.__TAURI__.core);

render();
refreshRuntime();
setInterval(refreshRuntime, 2500);
setInterval(refreshLogs, 2500);

function loadConfig() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    return normalizeConfig(saved ? { ...defaultConfig, ...saved } : defaultConfig);
  } catch {
    return normalizeConfig(defaultConfig);
  }
}

function normalizeConfig(input) {
  const next = structuredClone(input);
  next.port = Number(next.port || defaultConfig.port);
  next.extraEnv = Array.isArray(next.extraEnv) && next.extraEnv.length
    ? next.extraEnv
    : [{ key: "", value: "", enabled: true }];
  return next;
}

function saveConfig() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

function render() {
  const focus = captureFocus();
  const preview = buildPreview(config);
  const validation = validateConfig(config);
  const isTauri = Boolean(invoke);
  const endpoint = preview.endpoint;

  app.innerHTML = `
    <header class="topbar">
      <div>
        <div class="eyebrow">Tauri control panel</div>
        <h1>Coding Tools MCP</h1>
      </div>
      <div class="topbar-actions">
        <span class="runtime-pill ${runtime.running ? "is-running" : ""}">
          <span class="dot"></span>
          ${runtime.running ? `Running${runtime.pid ? ` - PID ${runtime.pid}` : ""}` : "Stopped"}
        </span>
        <button class="ghost" data-action="copy-command">Copy command</button>
        <button class="primary" data-action="start" ${runtime.running || validation.blockers.length ? "disabled" : ""}>
          ${busy === "start" ? "Starting..." : "Start"}
        </button>
        <button class="danger" data-action="stop" ${!runtime.running ? "disabled" : ""}>
          ${busy === "stop" ? "Stopping..." : "Stop"}
        </button>
      </div>
    </header>

    <section class="status-strip">
      <div>
        <span class="label">Endpoint</span>
        <strong>${escapeHtml(endpoint)}</strong>
      </div>
      <div>
        <span class="label">Profile</span>
        <strong>${escapeHtml(config.toolProfile)}</strong>
      </div>
      <div>
        <span class="label">Policy</span>
        <strong>${escapeHtml(config.permissionMode)}</strong>
      </div>
      <div>
        <span class="label">Runner</span>
        <strong>${escapeHtml(isTauri ? (config.runnerMode === "external" ? "External command" : "Bundled sidecar") : "Browser preview")}</strong>
      </div>
    </section>

    <div class="workspace">
      <section class="config-pane">
        ${renderValidation(validation)}
        ${renderCoreSettings()}
        ${renderPolicySettings()}
        ${renderAuthSettings()}
        ${renderAdvancedSettings()}
      </section>

      <aside class="inspector">
        ${renderHealthPanel()}
        ${renderCommandPanel(preview)}
        ${renderClientPanel(preview)}
        ${renderLogsPanel()}
      </aside>
    </div>

    ${toast ? `<div class="toast">${escapeHtml(toast)}</div>` : ""}
  `;

  wireEvents();
  restoreFocus(focus);
}

function renderCoreSettings() {
  return `
    <section class="group">
      <div class="group-head">
        <div>
          <h2>Server</h2>
          <p>Launch target, workspace, and transport.</p>
        </div>
      </div>
      <div class="stack runner-stack">
        ${optionSet("runnerMode", runnerModes, config.runnerMode)}
      </div>
      <div class="grid two">
        ${inputField("External command", "serverCommand", config.serverCommand, "uvx coding-tools-mcp", config.runnerMode !== "external")}
        ${inputField("Workspace", "workspace", config.workspace, "/path/to/repo")}
      </div>
      <div class="grid three">
        ${segmented("transport", [["http", "HTTP"], ["stdio", "Stdio"]], config.transport)}
        ${inputField("Host", "host", config.host, "127.0.0.1", config.transport === "stdio")}
        ${inputField("Port", "port", config.port, "8000", config.transport === "stdio", "number")}
      </div>
    </section>
  `;
}

function renderPolicySettings() {
  return `
    <section class="group">
      <div class="group-head">
        <div>
          <h2>Runtime policy</h2>
          <p>Common server-side policy flags.</p>
        </div>
      </div>
      <div class="stack">
        ${optionSet("toolProfile", toolProfiles, config.toolProfile)}
        ${optionSet("permissionMode", permissionModes, config.permissionMode)}
      </div>
      <div class="grid three tight">
        ${selectField("Shell env", "shellEnvInherit", shellModes, config.shellEnvInherit)}
        ${toggleField("Allow network flag", "allowNetwork", config.allowNetwork)}
        ${toggleField("Image tool", "enableViewImage", config.enableViewImage)}
      </div>
    </section>
  `;
}

function renderAuthSettings() {
  const showBearer = config.authMode === "bearer" || config.authMode === "oauth";
  const showOauth = config.authMode === "oauth";
  return `
    <section class="group">
      <div class="group-head">
        <div>
          <h2>Auth and exposure</h2>
          <p>Local HTTP defaults to no auth; remote exposure should use bearer or OAuth.</p>
        </div>
      </div>
      <div class="grid two">
        ${segmented("authMode", authModes.map(([value, label]) => [value, label]), config.authMode)}
        ${inputField("Public server URL", "serverUrl", config.serverUrl, "https://mcp.example.com")}
      </div>
      ${showBearer ? `
        <div class="grid two">
          ${inputField("Bearer token", "authToken", config.authToken, "token", false, "password")}
          ${showOauth ? inputField("OAuth password", "oauthPassword", config.oauthPassword, "operator password", false, "password") : ""}
        </div>
      ` : ""}
      ${showOauth ? `
        <div class="grid two">
          ${inputField("OAuth client id", "oauthClientId", config.oauthClientId, "optional")}
          ${inputField("OAuth client secret", "oauthClientSecret", config.oauthClientSecret, "optional", false, "password")}
          ${inputField("OAuth token secret", "oauthTokenSecret", config.oauthTokenSecret, "hex secret")}
          ${inputField("OAuth token TTL", "oauthTokenTtl", config.oauthTokenTtl, "2592000", false, "number")}
        </div>
      ` : ""}
    </section>
  `;
}

function renderAdvancedSettings() {
  return `
    <section class="group">
      <div class="group-head">
        <div>
          <h2>Advanced</h2>
          <p>Less common knobs stay editable without expanding the main surface.</p>
        </div>
      </div>
      <div class="grid two">
        ${inputField("Runtime root", "runtimeRoot", config.runtimeRoot, "/tmp/coding-tools-mcp")}
        ${toggleField("Trace logs", "trace", config.trace)}
      </div>
      <div class="grid two">
        ${inputField("Env include only", "envIncludeOnly", config.envIncludeOnly, "PATH,LANG")}
        ${inputField("Env exclude", "envExclude", config.envExclude, "TOKEN*,SECRET*")}
      </div>
      ${textareaField("Shell env set JSON", "envSetJson", config.envSetJson, '{"KEY":"value"}')}
      ${textareaField("Extra server arguments", "extraArgs", config.extraArgs, '--flag "value"')}
      <div class="advanced-env">
        <div class="row-head">
          <h3>Extra environment</h3>
          <button class="ghost compact" data-action="add-env">Add</button>
        </div>
        ${config.extraEnv.map((item, index) => `
          <div class="env-row">
            <label class="check">
              <input type="checkbox" data-env-enabled="${index}" ${item.enabled ? "checked" : ""} />
            </label>
            <input data-env-key="${index}" value="${escapeAttr(item.key)}" placeholder="KEY" />
            <input data-env-value="${index}" value="${escapeAttr(item.value)}" placeholder="value" />
            <button class="icon-button" title="Remove" data-action="remove-env" data-index="${index}">x</button>
          </div>
        `).join("")}
      </div>
      <div class="danger-zone">
        ${toggleField("Dangerous skip alias", "dangerouslySkipAllPermissions", config.dangerouslySkipAllPermissions)}
      </div>
    </section>
  `;
}

function renderHealthPanel() {
  const checks = health?.checks || [];
  return `
    <section class="panel">
      <div class="panel-head">
        <div>
          <h2>Health</h2>
          <p>${health ? escapeHtml(health.endpoint) : "Run a check after the server starts."}</p>
        </div>
        <button class="ghost compact" data-action="health" ${config.transport === "stdio" ? "disabled" : ""}>
          ${busy === "health" ? "Checking..." : "Check"}
        </button>
      </div>
      <div class="health-summary ${health?.ok ? "ok" : health ? "bad" : ""}">
        ${health ? (health.ok ? "Healthy" : "Needs attention") : "No check yet"}
      </div>
      <div class="check-list">
        ${checks.length ? checks.map(check => `
          <div class="check-item">
            <span class="check-dot ${check.ok ? "ok" : "bad"}"></span>
            <div>
              <strong>${escapeHtml(check.label)}</strong>
              <span>${escapeHtml(check.detail)}</span>
            </div>
          </div>
        `).join("") : `<p class="muted">HTTP discovery and MCP ping are checked with the selected auth mode.</p>`}
      </div>
    </section>
  `;
}

function renderCommandPanel(preview) {
  return `
    <section class="panel">
      <div class="panel-head">
        <div>
          <h2>Launch preview</h2>
          <p>Secrets are masked in this preview.</p>
        </div>
      </div>
      <pre class="command-preview">${escapeHtml(preview.display)}</pre>
    </section>
  `;
}

function renderClientPanel(preview) {
  const codex = config.transport === "stdio"
    ? `[mcp_servers.coding_tools]\ncommand = "${preview.executable}"\nargs = ${JSON.stringify(preview.args)}`
    : `URL: ${preview.endpoint}`;
  const json = config.transport === "stdio"
    ? JSON.stringify({ mcpServers: { "coding-tools": { command: preview.executable, args: preview.args } } }, null, 2)
    : JSON.stringify({ servers: { "coding-tools": { type: "http", url: preview.endpoint } } }, null, 2);

  return `
    <section class="panel">
      <div class="panel-head">
        <div>
          <h2>Client snippets</h2>
          <p>Generated from the same settings.</p>
        </div>
      </div>
      <div class="snippet-tabs">
        <button class="ghost compact" data-copy-text="${escapeAttr(codex)}">Copy Codex</button>
        <button class="ghost compact" data-copy-text="${escapeAttr(json)}">Copy JSON</button>
      </div>
      <pre class="snippet">${escapeHtml(codex)}</pre>
    </section>
  `;
}

function renderLogsPanel() {
  return `
    <section class="panel logs-panel">
      <div class="panel-head">
        <div>
          <h2>Logs</h2>
          <p>${logs.length ? `${logs.length} recent lines` : "No process output yet."}</p>
        </div>
        <button class="ghost compact" data-action="clear-logs">Clear</button>
      </div>
      <pre class="logs">${escapeHtml(logs.slice(-80).join("\n"))}</pre>
    </section>
  `;
}

function renderValidation(validation) {
  const items = [...validation.blockers, ...validation.warnings];
  if (!items.length) return "";
  return `
    <section class="notice ${validation.blockers.length ? "bad" : ""}">
      ${items.map(item => `<div>${escapeHtml(item)}</div>`).join("")}
    </section>
  `;
}

function inputField(label, field, value, placeholder = "", disabled = false, type = "text") {
  return `
    <label class="field">
      <span>${escapeHtml(label)}</span>
      <input data-field="${field}" type="${type}" value="${escapeAttr(value)}" placeholder="${escapeAttr(placeholder)}" ${disabled ? "disabled" : ""} />
    </label>
  `;
}

function textareaField(label, field, value, placeholder = "") {
  return `
    <label class="field wide">
      <span>${escapeHtml(label)}</span>
      <textarea data-field="${field}" placeholder="${escapeAttr(placeholder)}">${escapeHtml(value)}</textarea>
    </label>
  `;
}

function selectField(label, field, options, value) {
  return `
    <label class="field">
      <span>${escapeHtml(label)}</span>
      <select data-field="${field}">
        ${options.map(([option, text]) => `<option value="${option}" ${value === option ? "selected" : ""}>${escapeHtml(text)}</option>`).join("")}
      </select>
    </label>
  `;
}

function toggleField(label, field, checked) {
  return `
    <label class="toggle">
      <input type="checkbox" data-flag="${field}" ${checked ? "checked" : ""} />
      <span>${escapeHtml(label)}</span>
    </label>
  `;
}

function segmented(field, options, value) {
  return `
    <div class="segmented" role="group" aria-label="${escapeAttr(field)}">
      ${options.map(([option, label]) => `
        <button data-segment="${field}" data-value="${option}" class="${value === option ? "active" : ""}">
          ${escapeHtml(label)}
        </button>
      `).join("")}
    </div>
  `;
}

function optionSet(field, options, value) {
  return `
    <div class="option-set">
      ${options.map(([option, label, detail]) => `
        <button data-segment="${field}" data-value="${option}" class="${value === option ? "active" : ""}">
          <strong>${escapeHtml(label)}</strong>
          <span>${escapeHtml(detail)}</span>
        </button>
      `).join("")}
    </div>
  `;
}

function wireEvents() {
  app.querySelectorAll("[data-field]").forEach(element => {
    element.addEventListener("input", event => {
      const field = event.currentTarget.dataset.field;
      config[field] = field === "port" ? Number(event.currentTarget.value) : event.currentTarget.value;
      saveConfig();
      render();
    });
  });

  app.querySelectorAll("[data-flag]").forEach(element => {
    element.addEventListener("change", event => {
      config[event.currentTarget.dataset.flag] = event.currentTarget.checked;
      saveConfig();
      render();
    });
  });

  app.querySelectorAll("[data-segment]").forEach(button => {
    button.addEventListener("click", event => {
      config[event.currentTarget.dataset.segment] = event.currentTarget.dataset.value;
      saveConfig();
      render();
    });
  });

  app.querySelectorAll("[data-env-enabled]").forEach(input => {
    input.addEventListener("change", event => {
      config.extraEnv[Number(event.currentTarget.dataset.envEnabled)].enabled = event.currentTarget.checked;
      saveConfig();
      render();
    });
  });
  app.querySelectorAll("[data-env-key]").forEach(input => {
    input.addEventListener("input", event => {
      config.extraEnv[Number(event.currentTarget.dataset.envKey)].key = event.currentTarget.value;
      saveConfig();
      render();
    });
  });
  app.querySelectorAll("[data-env-value]").forEach(input => {
    input.addEventListener("input", event => {
      config.extraEnv[Number(event.currentTarget.dataset.envValue)].value = event.currentTarget.value;
      saveConfig();
      render();
    });
  });

  app.querySelectorAll("[data-action]").forEach(button => {
    button.addEventListener("click", () => handleAction(button.dataset.action, button.dataset.index));
  });

  app.querySelectorAll("[data-copy-text]").forEach(button => {
    button.addEventListener("click", () => copyText(button.dataset.copyText));
  });
}

async function handleAction(action, index) {
  if (action === "add-env") {
    config.extraEnv.push({ key: "", value: "", enabled: true });
    saveConfig();
    render();
    return;
  }
  if (action === "remove-env") {
    config.extraEnv.splice(Number(index), 1);
    if (!config.extraEnv.length) config.extraEnv.push({ key: "", value: "", enabled: true });
    saveConfig();
    render();
    return;
  }
  if (action === "copy-command") {
    await copyText(buildPreview(config).display);
    return;
  }
  if (action === "clear-logs") {
    logs = [];
    if (invoke) await invoke("clear_logs");
    render();
    return;
  }
  if (!invoke && ["start", "stop", "health"].includes(action)) {
    showToast("Open this through Tauri to control the local process.");
    return;
  }
  if (action === "start") await startServer();
  if (action === "stop") await stopServer();
  if (action === "health") await checkHealth();
}

async function startServer() {
  const validation = validateConfig(config);
  if (validation.blockers.length) {
    showToast(validation.blockers[0]);
    return;
  }
  busy = "start";
  render();
  try {
    runtime = await invoke("start_server", { config });
    await sleep(800);
    await refreshLogs();
    if (config.transport !== "stdio") await checkHealth();
  } catch (error) {
    showToast(String(error));
  } finally {
    busy = "";
    render();
  }
}

async function stopServer() {
  busy = "stop";
  render();
  try {
    runtime = await invoke("stop_server");
    await refreshLogs();
  } catch (error) {
    showToast(String(error));
  } finally {
    busy = "";
    render();
  }
}

async function checkHealth() {
  busy = "health";
  render();
  try {
    health = await invoke("check_health", { config });
  } catch (error) {
    health = {
      ok: false,
      endpoint: buildPreview(config).endpoint,
      checks: [{ label: "Health", ok: false, detail: String(error) }],
      raw: ""
    };
  } finally {
    busy = "";
    render();
  }
}

async function refreshRuntime() {
  if (!invoke) return;
  try {
    runtime = await invoke("runtime_status");
    render();
  } catch {
    // Keep the last known state visible.
  }
}

async function refreshLogs() {
  if (!invoke) return;
  try {
    logs = await invoke("read_logs");
    render();
  } catch {
    // Logs are best-effort.
  }
}

function validateConfig(input) {
  const blockers = [];
  const warnings = [];
  if (!input.workspace.trim()) blockers.push("Workspace is required.");
  if (input.runnerMode === "external" && !input.serverCommand.trim()) blockers.push("External command is required.");
  if (input.transport !== "stdio" && (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535)) {
    blockers.push("HTTP port must be between 1 and 65535.");
  }
  if (input.envSetJson.trim()) {
    try {
      const parsed = JSON.parse(input.envSetJson);
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
        blockers.push("Shell env set JSON must be an object.");
      }
    } catch {
      blockers.push("Shell env set JSON is not valid JSON.");
    }
  }
  try {
    if (input.runnerMode === "external") parseCommandLine(input.serverCommand);
    parseCommandLine(input.extraArgs);
  } catch (error) {
    blockers.push(error.message);
  }
  if (input.authMode === "bearer" && !input.authToken.trim()) warnings.push("Bearer mode should include a token.");
  if (input.permissionMode === "safe" && input.allowNetwork) warnings.push("Allow network opens only the network gate; trusted mode is clearer for full local development.");
  if (input.dangerouslySkipAllPermissions || input.permissionMode === "dangerous") warnings.push("Dangerous mode is for isolated containers or VMs.");
  if (input.authMode === "noauth" && input.toolProfile !== "read-only") warnings.push("Remote noauth should normally use the read-only tool profile.");
  return { blockers, warnings };
}

function buildPreview(input) {
  const runnerMode = input.runnerMode === "external" ? "external" : "bundled";
  let parts = [];
  if (runnerMode === "external") {
    try {
      parts = parseCommandLine(input.serverCommand);
    } catch {
      parts = ["uvx", "coding-tools-mcp"];
    }
  }
  const executable = runnerMode === "external" ? (parts.shift() || "uvx") : "coding-tools-mcp";
  const displayExecutable = runnerMode === "external" ? executable : "<bundled:coding-tools-mcp>";
  const args = [...parts];
  if (input.transport === "stdio") {
    args.push("--stdio");
  } else {
    args.push("--host", input.host || "127.0.0.1", "--port", String(input.port || 8000));
  }
  args.push("--workspace", input.workspace || "/path/to/repo");
  args.push("--tool-profile", input.toolProfile);
  args.push("--permission-mode", input.permissionMode);
  args.push("--shell-env-inherit", input.shellEnvInherit);
  if (input.allowNetwork) args.push("--allow-network");
  if (input.enableViewImage) args.push("--enable-view-image");
  if (input.authMode === "bearer" && input.authToken.trim()) args.push("--auth-token", input.authToken.trim());
  if (input.authMode === "oauth") args.push("--oauth-mode");
  if (input.dangerouslySkipAllPermissions) args.push("--dangerously-skip-all-permissions");
  try {
    args.push(...parseCommandLine(input.extraArgs));
  } catch {
    // Validation reports the parse problem; preview keeps the safe base command.
  }

  const env = {};
  if (input.trace) env.CODING_TOOLS_MCP_TRACE = "1";
  if (!input.enableViewImage) env.CODING_TOOLS_MCP_ENABLE_VIEW_IMAGE = "0";
  if (input.runtimeRoot.trim()) env.CODING_TOOLS_MCP_RUNTIME_ROOT = input.runtimeRoot.trim();
  if (input.envIncludeOnly.trim()) env.CODING_TOOLS_MCP_SHELL_ENV_INCLUDE_ONLY = input.envIncludeOnly.trim();
  if (input.envExclude.trim()) env.CODING_TOOLS_MCP_SHELL_ENV_EXCLUDE = input.envExclude.trim();
  if (input.envSetJson.trim()) env.CODING_TOOLS_MCP_SHELL_ENV_SET = input.envSetJson.trim();
  if (input.serverUrl.trim()) env.CODING_TOOLS_MCP_SERVER_URL = input.serverUrl.trim();
  if (input.authMode === "bearer") {
    env.CODING_TOOLS_MCP_AUTH_MODE = "bearer";
    if (input.authToken.trim()) env.CODING_TOOLS_MCP_AUTH_TOKEN = input.authToken.trim();
  }
  if (input.authMode === "oauth") {
    env.CODING_TOOLS_MCP_AUTH_MODE = "oauth";
    if (input.authToken.trim()) env.CODING_TOOLS_MCP_AUTH_TOKEN = input.authToken.trim();
    if (input.oauthPassword.trim()) env.CODING_TOOLS_MCP_OAUTH_PASSWORD = input.oauthPassword.trim();
    if (input.oauthClientId.trim()) env.CODING_TOOLS_MCP_OAUTH_CLIENT_ID = input.oauthClientId.trim();
    if (input.oauthClientSecret.trim()) env.CODING_TOOLS_MCP_OAUTH_CLIENT_SECRET = input.oauthClientSecret.trim();
    if (input.oauthTokenSecret.trim()) env.CODING_TOOLS_MCP_OAUTH_TOKEN_SECRET = input.oauthTokenSecret.trim();
    if (input.oauthTokenTtl.trim()) env.CODING_TOOLS_MCP_OAUTH_TOKEN_TTL = input.oauthTokenTtl.trim();
  }
  if (input.authMode === "noauth") env.CODING_TOOLS_MCP_AUTH_MODE = "noauth";
  for (const item of input.extraEnv) {
    if (item.enabled && item.key.trim()) env[item.key.trim()] = item.value;
  }

  const envPrefix = Object.entries(env).map(([key, value]) => {
    const masked = /TOKEN|SECRET|PASSWORD/.test(key) ? "********" : value;
    return `${key}=${shellQuote(masked)}`;
  });
  const display = [...envPrefix, shellQuote(displayExecutable), ...args.map(arg => {
    if (arg === input.authToken && input.authToken.trim()) return "********";
    return shellQuote(arg);
  })].join(" ");
  return {
    runnerMode,
    executable,
    args,
    env,
    display,
    endpoint: input.transport === "stdio" ? "stdio" : `http://${input.host || "127.0.0.1"}:${input.port || 8000}/mcp`
  };
}

function parseCommandLine(input) {
  const result = [];
  let current = "";
  let quote = "";
  let escaped = false;

  for (const char of input || "") {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = "";
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        result.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (escaped) current += "\\";
  if (quote) throw new Error("Unterminated quote in command line.");
  if (current) result.push(current);
  return result;
}

function shellQuote(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_\-./:=@]+$/.test(text)) return text;
  return `'${text.replaceAll("'", "'\\''")}'`;
}

async function copyText(text) {
  await navigator.clipboard.writeText(text);
  showToast("Copied.");
}

function showToast(message) {
  toast = message;
  render();
  setTimeout(() => {
    toast = "";
    render();
  }, 2200);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function captureFocus() {
  const element = document.activeElement;
  if (!element || !app.contains(element)) return null;
  const keys = ["field", "envKey", "envValue", "envEnabled"];
  const key = keys.find(name => element.dataset?.[name] !== undefined);
  if (!key) return null;
  return {
    key,
    value: element.dataset[key],
    start: element.selectionStart ?? null,
    end: element.selectionEnd ?? null
  };
}

function restoreFocus(focus) {
  if (!focus) return;
  const selector = `[data-${kebab(focus.key)}="${cssEscape(focus.value)}"]`;
  const element = app.querySelector(selector);
  if (!element) return;
  element.focus();
  if (focus.start !== null && typeof element.setSelectionRange === "function") {
    try {
      element.setSelectionRange(focus.start, focus.end);
    } catch {
      // Some input types do not support text selection.
    }
  }
}

function kebab(value) {
  return value.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
}

function cssEscape(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttr(value) {
  return escapeHtml(value);
}
