use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    io::{BufRead, BufReader, Read, Write},
    net::{TcpStream, ToSocketAddrs},
    process::{Child, Command as StdCommand, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};
use tauri_plugin_shell::ShellExt;

#[derive(Default, Clone)]
struct SharedState {
    child: Arc<Mutex<Option<Child>>>,
    logs: Arc<Mutex<Vec<String>>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EnvPair {
    key: String,
    value: String,
    enabled: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct McpConfig {
    runner_mode: String,
    server_command: String,
    workspace: String,
    transport: String,
    host: String,
    port: u16,
    tool_profile: String,
    permission_mode: String,
    shell_env_inherit: String,
    allow_network: bool,
    enable_view_image: bool,
    trace: bool,
    auth_mode: String,
    auth_token: String,
    oauth_password: String,
    oauth_client_id: String,
    oauth_client_secret: String,
    oauth_token_secret: String,
    oauth_token_ttl: String,
    server_url: String,
    runtime_root: String,
    env_include_only: String,
    env_exclude: String,
    env_set_json: String,
    dangerously_skip_all_permissions: bool,
    extra_args: String,
    extra_env: Vec<EnvPair>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BuildResult {
    runner_mode: String,
    executable: String,
    args: Vec<String>,
    env: BTreeMap<String, String>,
    display: String,
    endpoint: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeStatus {
    running: bool,
    pid: Option<u32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthCheck {
    label: String,
    ok: bool,
    detail: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthReport {
    ok: bool,
    endpoint: String,
    checks: Vec<HealthCheck>,
    raw: String,
}

#[derive(Debug)]
struct HttpResponse {
    status: u16,
    body: String,
    head: String,
}

const SIDECAR_NAME: &str = "coding-tools-mcp";
const RUNNER_BUNDLED: &str = "bundled";
const RUNNER_EXTERNAL: &str = "external";

#[tauri::command]
fn build_command(config: McpConfig) -> Result<BuildResult, String> {
    build_launch(&config)
}

#[tauri::command]
fn start_server(
    app: tauri::AppHandle,
    config: McpConfig,
    state: tauri::State<'_, SharedState>,
) -> Result<RuntimeStatus, String> {
    let launch = build_launch(&config)?;
    {
        let mut guard = state.child.lock().map_err(|_| "process lock poisoned")?;
        if let Some(child) = guard.as_mut() {
            if child.try_wait().map_err(|err| err.to_string())?.is_none() {
                return Ok(RuntimeStatus {
                    running: true,
                    pid: Some(child.id()),
                });
            }
        }
        *guard = None;
    }

    push_log(&state.logs, format!("$ {}", launch.display));
    let mut command = create_process_command(&app, &launch)?;
    command.stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|err| format!("failed to start server: {err}"))?;

    if let Some(stdout) = child.stdout.take() {
        stream_logs(stdout, "stdout", state.logs.clone());
    }
    if let Some(stderr) = child.stderr.take() {
        stream_logs(stderr, "stderr", state.logs.clone());
    }

    let pid = child.id();
    let mut guard = state.child.lock().map_err(|_| "process lock poisoned")?;
    *guard = Some(child);
    Ok(RuntimeStatus {
        running: true,
        pid: Some(pid),
    })
}

#[tauri::command]
fn stop_server(state: tauri::State<'_, SharedState>) -> Result<RuntimeStatus, String> {
    let mut guard = state.child.lock().map_err(|_| "process lock poisoned")?;
    if let Some(mut child) = guard.take() {
        let _ = child.kill();
        let _ = child.wait();
        push_log(&state.logs, "server stopped".to_string());
    }
    Ok(RuntimeStatus {
        running: false,
        pid: None,
    })
}

#[tauri::command]
fn runtime_status(state: tauri::State<'_, SharedState>) -> Result<RuntimeStatus, String> {
    let mut guard = state.child.lock().map_err(|_| "process lock poisoned")?;
    if let Some(child) = guard.as_mut() {
        if child.try_wait().map_err(|err| err.to_string())?.is_none() {
            return Ok(RuntimeStatus {
                running: true,
                pid: Some(child.id()),
            });
        }
    }
    *guard = None;
    Ok(RuntimeStatus {
        running: false,
        pid: None,
    })
}

#[tauri::command]
fn read_logs(state: tauri::State<'_, SharedState>) -> Result<Vec<String>, String> {
    let logs = state.logs.lock().map_err(|_| "log lock poisoned")?;
    Ok(logs.clone())
}

#[tauri::command]
fn clear_logs(state: tauri::State<'_, SharedState>) -> Result<(), String> {
    let mut logs = state.logs.lock().map_err(|_| "log lock poisoned")?;
    logs.clear();
    Ok(())
}

#[tauri::command]
fn check_health(config: McpConfig) -> Result<HealthReport, String> {
    let launch = build_launch(&config)?;
    if config.transport == "stdio" {
        return Ok(HealthReport {
            ok: false,
            endpoint: "stdio".to_string(),
            checks: vec![HealthCheck {
                label: "HTTP health".to_string(),
                ok: false,
                detail: "Health checks require Streamable HTTP transport.".to_string(),
            }],
            raw: String::new(),
        });
    }

    let mut checks = Vec::new();
    let discovery = http_request(&config.host, config.port, "GET", "/.well-known/mcp.json", None, None);
    let mut raw = String::new();
    match discovery {
        Ok(response) => {
            raw.push_str(&response.head);
            raw.push('\n');
            raw.push_str(&response.body);
            checks.push(HealthCheck {
                label: "Discovery".to_string(),
                ok: (200..300).contains(&response.status),
                detail: format!("HTTP {}", response.status),
            });
        }
        Err(err) => checks.push(HealthCheck {
            label: "Discovery".to_string(),
            ok: false,
            detail: err,
        }),
    }

    let body = r#"{"jsonrpc":"2.0","id":1,"method":"ping","params":{}}"#;
    let token = match config.auth_mode.as_str() {
        "bearer" if !config.auth_token.trim().is_empty() => Some(config.auth_token.trim()),
        _ => None,
    };
    let ping = http_request(&config.host, config.port, "POST", "/mcp", Some(body), token);
    match ping {
        Ok(response) => {
            raw.push('\n');
            raw.push_str(&response.head);
            raw.push('\n');
            raw.push_str(&response.body);
            let protected_ok = response.status == 401 && config.auth_mode == "oauth";
            checks.push(HealthCheck {
                label: "MCP ping".to_string(),
                ok: (200..300).contains(&response.status) || protected_ok,
                detail: if protected_ok {
                    "HTTP 401, OAuth protection is active".to_string()
                } else {
                    format!("HTTP {}", response.status)
                },
            });
        }
        Err(err) => checks.push(HealthCheck {
            label: "MCP ping".to_string(),
            ok: false,
            detail: err,
        }),
    }

    let ok = checks.iter().all(|check| check.ok);
    Ok(HealthReport {
        ok,
        endpoint: launch.endpoint,
        checks,
        raw: trim_raw(raw),
    })
}

fn build_launch(config: &McpConfig) -> Result<BuildResult, String> {
    let workspace = config.workspace.trim();
    if workspace.is_empty() {
        return Err("workspace is required".to_string());
    }
    if config.transport != "stdio" && config.host.trim().is_empty() {
        return Err("host is required for HTTP transport".to_string());
    }
    if config.transport != "stdio" && config.port == 0 {
        return Err("port must be between 1 and 65535 for HTTP transport".to_string());
    }

    let runner_mode = if config.runner_mode == RUNNER_EXTERNAL {
        RUNNER_EXTERNAL
    } else {
        RUNNER_BUNDLED
    };

    let (executable, mut args) = if runner_mode == RUNNER_EXTERNAL {
        let mut parts = parse_command_line(config.server_command.trim())?;
        if parts.is_empty() {
            return Err("server command is required".to_string());
        }
        (parts.remove(0), parts)
    } else {
        (SIDECAR_NAME.to_string(), Vec::new())
    };

    if config.transport == "stdio" {
        args.push("--stdio".to_string());
    } else {
        args.extend(["--host".to_string(), config.host.trim().to_string()]);
        args.extend(["--port".to_string(), config.port.to_string()]);
    }

    args.extend(["--workspace".to_string(), workspace.to_string()]);
    push_arg_pair(&mut args, "--tool-profile", &config.tool_profile);
    push_arg_pair(&mut args, "--permission-mode", &config.permission_mode);
    push_arg_pair(&mut args, "--shell-env-inherit", &config.shell_env_inherit);

    if config.allow_network {
        args.push("--allow-network".to_string());
    }
    if config.enable_view_image {
        args.push("--enable-view-image".to_string());
    }
    if config.auth_mode == "oauth" {
        args.push("--oauth-mode".to_string());
    }
    if config.dangerously_skip_all_permissions {
        args.push("--dangerously-skip-all-permissions".to_string());
    }

    args.extend(parse_command_line(&config.extra_args)?);

    let mut env = BTreeMap::new();
    set_if(&mut env, "CODING_TOOLS_MCP_TRACE", "1", config.trace);
    set_if(&mut env, "CODING_TOOLS_MCP_ENABLE_VIEW_IMAGE", "0", !config.enable_view_image);
    set_env_value(&mut env, "CODING_TOOLS_MCP_RUNTIME_ROOT", &config.runtime_root);
    set_env_value(&mut env, "CODING_TOOLS_MCP_SHELL_ENV_INCLUDE_ONLY", &config.env_include_only);
    set_env_value(&mut env, "CODING_TOOLS_MCP_SHELL_ENV_EXCLUDE", &config.env_exclude);
    set_env_value(&mut env, "CODING_TOOLS_MCP_SHELL_ENV_SET", &config.env_set_json);
    set_env_value(&mut env, "CODING_TOOLS_MCP_SERVER_URL", &config.server_url);

    match config.auth_mode.as_str() {
        "bearer" => {
            env.insert("CODING_TOOLS_MCP_AUTH_MODE".to_string(), "bearer".to_string());
            set_env_value(&mut env, "CODING_TOOLS_MCP_AUTH_TOKEN", &config.auth_token);
        }
        "oauth" => {
            env.insert("CODING_TOOLS_MCP_AUTH_MODE".to_string(), "oauth".to_string());
            set_env_value(&mut env, "CODING_TOOLS_MCP_AUTH_TOKEN", &config.auth_token);
            set_env_value(&mut env, "CODING_TOOLS_MCP_OAUTH_PASSWORD", &config.oauth_password);
            set_env_value(&mut env, "CODING_TOOLS_MCP_OAUTH_CLIENT_ID", &config.oauth_client_id);
            set_env_value(&mut env, "CODING_TOOLS_MCP_OAUTH_CLIENT_SECRET", &config.oauth_client_secret);
            set_env_value(&mut env, "CODING_TOOLS_MCP_OAUTH_TOKEN_SECRET", &config.oauth_token_secret);
            set_env_value(&mut env, "CODING_TOOLS_MCP_OAUTH_TOKEN_TTL", &config.oauth_token_ttl);
        }
        "noauth" => {
            env.insert("CODING_TOOLS_MCP_AUTH_MODE".to_string(), "noauth".to_string());
        }
        _ => {}
    }

    for item in &config.extra_env {
        if item.enabled && !item.key.trim().is_empty() {
            env.insert(item.key.trim().to_string(), item.value.clone());
        }
    }

    let endpoint = if config.transport == "stdio" {
        "stdio".to_string()
    } else {
        format!("http://{}:{}/mcp", config.host.trim(), config.port)
    };
    let display_executable = if runner_mode == RUNNER_BUNDLED {
        format!("<bundled:{SIDECAR_NAME}>")
    } else {
        executable.clone()
    };
    let display = render_command(&display_executable, &args, &env);
    Ok(BuildResult {
        runner_mode: runner_mode.to_string(),
        executable,
        args,
        env,
        display,
        endpoint,
    })
}

fn create_process_command(app: &tauri::AppHandle, launch: &BuildResult) -> Result<StdCommand, String> {
    if launch.runner_mode == RUNNER_BUNDLED {
        let command = app
            .shell()
            .sidecar(SIDECAR_NAME)
            .map_err(|err| format!("bundled MCP sidecar is not available: {err}"))?
            .args(&launch.args)
            .envs(launch.env.clone());
        Ok(command.into())
    } else {
        let mut command = StdCommand::new(&launch.executable);
        command.args(&launch.args).envs(launch.env.iter());
        Ok(command)
    }
}

fn push_arg_pair(args: &mut Vec<String>, name: &str, value: &str) {
    let trimmed = value.trim();
    if !trimmed.is_empty() {
        args.push(name.to_string());
        args.push(trimmed.to_string());
    }
}

fn set_if(env: &mut BTreeMap<String, String>, key: &str, value: &str, enabled: bool) {
    if enabled {
        env.insert(key.to_string(), value.to_string());
    }
}

fn set_env_value(env: &mut BTreeMap<String, String>, key: &str, value: &str) {
    let trimmed = value.trim();
    if !trimmed.is_empty() {
        env.insert(key.to_string(), trimmed.to_string());
    }
}

fn parse_command_line(input: &str) -> Result<Vec<String>, String> {
    let mut args = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut escaped = false;

    for ch in input.chars() {
        if escaped {
            current.push(ch);
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            continue;
        }
        match quote {
            Some(q) if ch == q => quote = None,
            Some(_) => current.push(ch),
            None if ch == '\'' || ch == '"' => quote = Some(ch),
            None if ch.is_whitespace() => {
                if !current.is_empty() {
                    args.push(std::mem::take(&mut current));
                }
            }
            None => current.push(ch),
        }
    }
    if escaped {
        current.push('\\');
    }
    if quote.is_some() {
        return Err("unterminated quote in command line".to_string());
    }
    if !current.is_empty() {
        args.push(current);
    }
    Ok(args)
}

fn render_command(executable: &str, args: &[String], env: &BTreeMap<String, String>) -> String {
    let mut rendered = Vec::new();
    for (key, value) in env {
        let value = if is_sensitive_key(key) {
            "********"
        } else {
            value.as_str()
        };
        rendered.push(format!("{key}={}", shell_quote(value)));
    }
    rendered.push(shell_quote(executable));
    rendered.extend(args.iter().map(|arg| shell_quote(arg)));
    rendered.join(" ")
}

fn shell_quote(value: &str) -> String {
    if value.chars().all(|ch| ch.is_ascii_alphanumeric() || "-_./:=@".contains(ch)) {
        return value.to_string();
    }
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn is_sensitive_key(key: &str) -> bool {
    let upper = key.to_ascii_uppercase();
    upper.contains("TOKEN") || upper.contains("SECRET") || upper.contains("PASSWORD")
}

fn push_log(logs: &Arc<Mutex<Vec<String>>>, line: String) {
    if let Ok(mut guard) = logs.lock() {
        guard.push(line);
        let overflow = guard.len().saturating_sub(600);
        if overflow > 0 {
            guard.drain(0..overflow);
        }
    }
}

fn stream_logs<R>(reader: R, label: &'static str, logs: Arc<Mutex<Vec<String>>>)
where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        let reader = BufReader::new(reader);
        for line in reader.lines().flatten() {
            push_log(&logs, format!("[{label}] {line}"));
        }
    });
}

fn http_request(
    host: &str,
    port: u16,
    method: &str,
    path: &str,
    body: Option<&str>,
    bearer: Option<&str>,
) -> Result<HttpResponse, String> {
    let addr = format!("{}:{}", host.trim_matches(['[', ']']), port);
    let mut addrs = addr
        .to_socket_addrs()
        .map_err(|err| format!("resolve failed: {err}"))?;
    let target = addrs.next().ok_or_else(|| "no socket address found".to_string())?;
    let mut stream = TcpStream::connect_timeout(&target, Duration::from_secs(2))
        .map_err(|err| format!("connect failed: {err}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .map_err(|err| err.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(3)))
        .map_err(|err| err.to_string())?;

    let payload = body.unwrap_or("");
    let mut request = format!(
        "{method} {path} HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\nAccept: application/json, text/event-stream\r\nMCP-Protocol-Version: 2025-06-18\r\n"
    );
    if let Some(token) = bearer {
        request.push_str(&format!("Authorization: Bearer {token}\r\n"));
    }
    if body.is_some() {
        request.push_str("Content-Type: application/json\r\n");
        request.push_str(&format!("Content-Length: {}\r\n", payload.len()));
    }
    request.push_str("\r\n");
    request.push_str(payload);

    stream
        .write_all(request.as_bytes())
        .map_err(|err| format!("write failed: {err}"))?;

    let mut raw = String::new();
    stream
        .read_to_string(&mut raw)
        .map_err(|err| format!("read failed: {err}"))?;

    let (head, body) = raw.split_once("\r\n\r\n").unwrap_or((&raw, ""));
    let status = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .unwrap_or(0);

    Ok(HttpResponse {
        status,
        body: body.to_string(),
        head: head.to_string(),
    })
}

fn trim_raw(raw: String) -> String {
    const LIMIT: usize = 2400;
    if raw.len() <= LIMIT {
        return raw;
    }

    let mut end = LIMIT.min(raw.len());
    while end > 0 && !raw.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}...\n[truncated]", &raw[..end])
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(SharedState::default())
        .invoke_handler(tauri::generate_handler![
            build_command,
            start_server,
            stop_server,
            runtime_status,
            read_logs,
            clear_logs,
            check_health
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
