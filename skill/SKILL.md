---
name: dsh-mcp-manager
description: Manage MCP (Model Context Protocol) servers in a running DSH (DeepSeek Harness) instance through the dsh-mcp-manager plugin API. Add, configure, enable/disable, health-check, and reconnect MCP services, inspect event logs, and import/export MCP configuration (including Claude Desktop mcpServers format). Use when the user asks to manage MCP services in DSH, troubleshoot an offline or unreachable MCP server, view MCP logs, or migrate MCP configuration into or out of DSH.
---

# dsh-mcp-manager

`dsh-mcp-manager` is a DSH plugin that gives agents and humans a single control
plane for every MCP server attached to a DSH profile. This skill teaches an
agent when and how to drive it: either through the bundled zero-dependency CLI
(`scripts/mcp-manager.mjs`) or by calling the plugin's HTTP API directly.

## When to use this skill

- Add a new MCP server to DSH (stdio process or streamable-http endpoint)
- Enable / disable an MCP service without losing its configuration
- Check whether MCP servers are online, offline, connecting, or not loaded
- Reconnect a stuck MCP entry (restarts its loader fiber)
- Read the manager's event log (state transitions, probes, admin actions)
- Export the whole MCP configuration to a JSON file (secrets redacted by default)
- Import MCP configuration, including Claude Desktop `{"mcpServers": {...}}` format

## When NOT to use this skill

- The DSH instance is not running, or the plugin is not installed — install it
  first: `dsh plugin --profile <profile> add github:nomorenormal-commits/dsh-mcp-manager-MCP`
- The user wants to manage MCP servers for a different host (Claude Desktop,
  Cursor, etc.) — this skill only manages DSH profiles.
- Editing raw `cordis.patch.yml` by hand. The plugin owns a managed block in
  that file; edits between the `# >>> dsh-mcp-manager managed block` markers
  are overwritten.

## Prerequisites

1. DSH >= 0.1.2 running with the plugin installed (the plugin exposes both the
   settings-page UI and the HTTP API).
2. The DSH web URL **including its token**, printed at startup, e.g.
   `http://127.0.0.1:3199/?token=XXXX`. The token is required: every API call
   must first exchange it for a session cookie (the CLI does this for you).
   You can also pass it via env vars `DSH_URL` and `DSH_TOKEN`.

## Quick start (CLI)

```sh
# List all MCP servers with live status
node scripts/mcp-manager.mjs --base "http://127.0.0.1:3199/?token=XXXX" list

# Add a stdio server (env/arg flags are repeatable)
node scripts/mcp-manager.mjs --base "..." add github --type stdio \
  --command npx --arg -y --arg @modelcontextprotocol/server-github \
  --env GITHUB_TOKEN=ghp_xxx

# Add a remote HTTP server
node scripts/mcp-manager.mjs --base "..." add web --type http \
  --url https://example.com/mcp --header Authorization="Bearer xxx"

# Daily operations
node scripts/mcp-manager.mjs --base "..." disable github
node scripts/mcp-manager.mjs --base "..." enable github
node scripts/mcp-manager.mjs --base "..." check            # probe everything
node scripts/mcp-manager.mjs --base "..." check github     # probe one
node scripts/mcp-manager.mjs --base "..." reconnect github
node scripts/mcp-manager.mjs --base "..." logs --server github --limit 50
node scripts/mcp-manager.mjs --base "..." remove github

# Backup & migration
node scripts/mcp-manager.mjs --base "..." export --out backup.json
node scripts/mcp-manager.mjs --base "..." import claude_desktop_config.json --mode merge
```

All output is JSON on stdout; errors go to stderr with exit code 1, so agents
can parse results deterministically.

## Command reference

| Command | API call | Notes |
| --- | --- | --- |
| `meta` | `GET /api/meta` | Plugin version, profile dir, patch status, templates |
| `list` | `GET /api/servers` | Views with `status`, `summary`, `patch` |
| `add <name> --type stdio --command <cmd> [--arg x]... [--env K=V]... [--cwd dir] [--timeout ms] [--fail-on-startup-error] [--disabled]` | `POST /api/servers` | Fails if name exists |
| `add <name> --type http --url <url> [--header K=V]...` | `POST /api/servers` | |
| `set <name> [same flags]` | `POST /api/servers` with `originalName` | Merge-edit existing config |
| `enable <name>` / `disable <name>` | `POST /api/servers/toggle` | Keeps config on disk |
| `remove <name>` | `POST /api/servers/delete` | Managed entries only |
| `check [name]` | `POST /api/servers/check` | Omit name to check all |
| `reconnect <name>` | `POST /api/servers/reconnect` | Restarts loader fiber |
| `logs [--server name] [--since ISO] [--limit n]` | `GET /api/logs` | Newest last |
| `export [--no-redact] [--out file]` | `GET /api/export` | Redaction on by default |
| `import <file> [--mode merge\|replace]` | `POST /api/import` | Accepts plugin export format and Claude Desktop format |

## Server object model

| Field | stdio | http | Description |
| --- | --- | --- | --- |
| `serverName` | ✓ | ✓ | 1–32 chars, `[A-Za-z0-9_-]`; becomes tool prefix `mcp__<name>__` |
| `transport` | ✓ | ✓ | `stdio` or `streamable-http` |
| `command` | ✓ | | Executable, e.g. `npx` |
| `args` | ✓ | | String array |
| `env` | ✓ | | Map of environment variables (secrets live here) |
| `cwd` | opt | | Working directory |
| `url` | | ✓ | Endpoint URL |
| `headers` | | ✓ | Map of HTTP headers (secrets live here) |
| `toolCallTimeoutMs` | opt | opt | Default 60000 |
| `failOnStartupError` | opt | opt | Default false |
| `disabled` | opt | opt | Parked but kept |

## Status semantics

| Status | Meaning |
| --- | --- |
| `online` | Loader fiber `ACTIVE`; for HTTP servers the last reachability probe succeeded |
| `offline` | Fiber `FAILED`, or the HTTP probe failed/timed out |
| `missing` | Config on disk but no live loader entry (usually needs a DSH restart) |
| `connecting` | Fiber `PENDING` / `LOADING` / `UNLOADING` |
| `paused` | `disabled: true`; not loaded, config kept |

**stdio boundary:** stdio child processes are owned by the official
`@deepseek-ai/dsh-mcp-client` (auto-reconnect included). Their stderr never
passes through this plugin and they cannot be probed from outside, so stdio
"offline" reflects the fiber state only. HTTP servers get a real reachability
probe (any HTTP response, even 401/405, counts as reachable).

## HTTP API reference (fallback when the CLI is unavailable)

Base path: `/dsh-mcp-manager/api`. Authenticate first:
`GET <origin>/?token=<token>` and keep the `set-cookie` value as a `Cookie`
header on every subsequent request. All routes return
`{ ok: boolean, ... }` or `{ ok: false, error, details? }`.

| Method & path | Body / query |
| --- | --- |
| `GET /meta` | — |
| `GET /servers` | — |
| `POST /servers` | `{ server, originalName? }` |
| `POST /servers/toggle` | `{ serverName, enabled }` |
| `POST /servers/delete` | `{ serverName }` |
| `POST /servers/reconnect` | `{ serverName }` |
| `POST /servers/check` | `{ serverName? }` (empty = all) |
| `GET /logs` | `?serverName=&since=&limit=` |
| `GET /export` | `?redact=0` disables redaction |
| `POST /import` | `{ payload, mode: "merge" \| "replace" }` |

## Safety rules

- **Secrets:** `export` redacts env/header values matching
  `token|secret|password|authorization|key` by default. Only pass
  `--no-redact` when the user explicitly wants a full-fidelity backup.
- **Import modes:** `merge` overwrites same-named servers and keeps the rest;
  `replace` wipes ALL managed servers first. Confirm with the user before
  `replace`.
- **External entries** (rows added by hand or other tools, entry id not
  starting with `dsh-mcp-manager-`) are read-only: you may disable them, but
  never edit or delete them through this plugin.
- **Writes are durable:** every mutation lands in the profile's
  `cordis.patch.yml` managed block (with `.bak` backup) before the hot reload,
  so a failed hot-reload never loses configuration.
