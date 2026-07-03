# Coding Tools Conductor

Coding Tools Conductor (`ctc`) is an orchestration layer above `coding-tools-mcp`.
It exposes an MCP server to models and talks to the lower Python MCP server as an
MCP client. The TUI is an optional attach process, not the core runtime.

## Layering Boundaries

1. Single atomic filesystem, process, and git operations belong to
   `coding-tools-mcp`; this project forwards them instead of rebuilding them.
2. Cross-tool state, policy, workspace lifecycle, human review checkpoints, and
   handoff flows belong to Coding Tools Conductor.
3. Conductor calls the lower layer through MCP. It must not import the Python
   project or run shell/git directly. The only exception is the future
   `workspace/` module, where managed git worktree creation and cleanup must run
   in the source repository before the lower MCP server is pointed at the
   worktree.

CI lint keeps `execa` out of every module except `src/workspace/` and the setup
wizard.

## M1 Surface

- `ctc --version`
- `ctc start [path]` starts a model-facing MCP server over stdio.
- Backend modes:
  - `stdio`: spawn `coding-tools-mcp --stdio --workspace <path>` or a profile /
    CLI supplied command.
  - `http`: connect to a Streamable HTTP MCP endpoint with an optional bearer
    token read from an environment variable.
- Backend tools are re-exposed without prefixes, subject to profile allow/deny
  policy.
- Every proxied tool call emits a JSONL audit event under `~/.ctc/logs/`.

Example:

```bash
ctc start /path/to/repo --backend stdio
ctc start /path/to/repo --backend-command coding-tools-mcp --stdio --workspace /path/to/repo
ctc start /path/to/repo --backend-command-json '["coding-tools-mcp","--stdio","--workspace","/path/to/repo"]'
ctc start /path/to/repo --backend http --backend-url http://127.0.0.1:8765/mcp --backend-token-env CTC_TOKEN
```

## M2 Surface

Conductor now adds three model-facing tools above the transparent proxy:

- `open_workspace` opens either a direct workspace or an isolated detached git
  worktree and then points the lower MCP server at that path with
  `set_default_cwd`.
- `close_workspace` closes the active workspace and removes managed worktrees
  when they are clean, or when `force` is explicitly passed.
- `show_changes` creates a temporary-index git snapshot, diffs it against
  `refs/ctc/review/<session>/baseline`, `last-shown`, or `HEAD`, and advances
  `last-shown` after each review checkpoint.

Human-side workspace commands:

```bash
ctc ws list
ctc ws clean --yes
ctc ws clean --force --yes
ctc ws merge <session-id>
```

Worktree creation and cleanup are the only direct git operations in the core
runtime. Review checkpoints run git through the lower `exec_command` tool so the
layering boundary stays intact.

## M3 Surface

`open_workspace` now returns a context guide in addition to workspace metadata:

- repository-root `AGENTS.md`, `CLAUDE.md`, and `.cursorrules` files are listed
  with byte counts; root-level files are inlined up to a fixed safety limit.
- nested instruction files are listed by path so models know where deeper rules
  exist before editing there.
- workspace skills are discovered from `.ctc/skills/<name>/SKILL.md`, with
  `.claude/skills/` read as a compatibility fallback.

The model-facing `load_skill` tool returns the full `SKILL.md` content for a
skill listed by `open_workspace.context.skills`.

Profile setup and diagnostics are available from the human CLI:

```bash
ctc setup /path/to/repo
ctc setup /path/to/repo --yes --skip-smoke --default-mode worktree
ctc doctor /path/to/repo
ctc doctor /path/to/repo --skip-backend
```

Profiles are stored as JSON under `~/.ctc/profiles/<repo-hash>.json`. HTTP
bearer tokens are never written directly; profiles store `env:<NAME>` references
such as `env:CTC_TOKEN`.

## M4 Surface

Conductor now includes the first baton handoff protocol and a human attach TUI.

Model-facing baton tools write only inside the active workspace `.baton/`
directory:

- `baton_write_plan(content)` writes `.baton/plan.md`.
- `baton_read_plan()` reads `.baton/plan.md`.
- `baton_update_status(phase, step?, state, note?)` writes
  `.baton/status.json` with an `updatedAt` timestamp.
- `baton_write_report(content)` writes `.baton/report.md`.

The baton directory also contains an `artifacts/` folder for future diff or log
attachments. It is intended as local handoff state; add `.baton/` to workspace
gitignore templates when using it.

Human-side commands:

```bash
ctc baton show /path/to/repo
ctc tui
ctc tui <session-id>
```

`ctc tui` attaches to the latest session log by default. It shows session
metadata, backend status, recent tool calls, the latest `show_changes` diff, and
current baton status. If the model calls the lower `request_permissions` tool
while the TUI is attached, Conductor pauses that request for a local `y` / `n`
decision. Without an attached TUI, the request falls back to the lower backend's
existing permission flow.

## M5 Surface

The ChatGPT Apps adapter is optional and remains isolated under
`src/adapters/chatgpt/`. Core Conductor behavior does not depend on it, and it
is disabled unless the workspace profile contains:

```json
{ "adapters": ["chatgpt"] }
```

You can also write that flag during setup:

```bash
ctc setup /path/to/repo --yes --skip-smoke --adapter chatgpt
```

When enabled, Conductor advertises MCP widget resources and adds ChatGPT Apps
metadata to three high-value tools only:

- `open_workspace` renders a workspace/context guide card.
- `show_changes` renders a review diff card.
- `baton_update_status` renders a baton progress card.

The adapter uses standard MCP Apps metadata (`_meta.ui.resourceUri`) plus
ChatGPT compatibility aliases such as `_meta["openai/outputTemplate"]`. It is a
host-specific presentation layer; the model-facing tool names and core tool
results stay unchanged.
