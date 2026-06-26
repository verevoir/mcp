# Using verevoir with MCP clients

`@verevoir/mcp` is a stdio MCP server and works with any client that supports the stdio transport. This page gives the universal pattern first, then per-client config snippets.

## Universal stdio pattern

All stdio clients spawn the server as a subprocess. The canonical invocation:

```
command: npx
args:    [-y, @verevoir/mcp]
```

For local development (iterating on the server itself, skipping the npm publish cycle):

```
command: node
args:    [/absolute/path/to/mcp/dist/bin.js]
```

### Environment block

Pass credentials as environment variables. Only the vars for the backends you use are required — the server starts regardless of which are set and surfaces missing-env errors at tool-call time, naming the variable.

```jsonc
{
  "env": {
    // --- Provider keys (LLM worker / governance tools) ---
    "ANTHROPIC_API_KEY": "sk-ant-...",
    "OPENAI_API_KEY": "sk-...",
    "GEMINI_API_KEY": "...",
    "DEEPSEEK_API_KEY": "...",

    // --- Model tier selection (optional) ---
    // "AIGENCY_MODEL_REASONING": "claude-opus-4-5",
    // "AIGENCY_REASONING_PROVIDER": "anthropic",
    // "AIGENCY_WORKER_URL": "http://localhost:11434/v1",
    // "AIGENCY_WORKER_MODEL": "mistral:7b",
    // "AIGENCY_WORKER_API_KEY": "...",

    // --- Source / workflow backends ---
    "NOTION_API_KEY": "ntn_...",
    "GITHUB_TOKEN": "ghp_...",
    "TRELLO_API_KEY": "...",
    "TRELLO_API_TOKEN": "...",
    "TRELLO_REFERER": "https://your-power-up-origin",
  },
}
```

Full env var reference: see the [README](../README.md) provider sections.

### Project pointer

On startup the server looks for a `verevoir-mcp` fenced block in `AGENTS.md` in its working directory. Add one to point the server at project documentation and task trackers:

````markdown
```verevoir-mcp
{
  "notion": {
    "workspaceRootPageId": "11112222-3333-4444-5555-666677778888",
    "databases": {
      "work_tracker": "aaaa1111-2222-3333-4444-555566667777",
      "adrs":         "bbbb1111-2222-3333-4444-555566667777"
    }
  }
}
```
````

Resolution precedence: `--manifest <path>` → `AGENTS.md` block → `verevoir-mcp.json` → `aigency.json` → no-project mode. See the [README](../README.md) for full details.

---

## Claude Code

**Config files** (lowest-precedence to highest):

- `~/.claude.json` — user-scoped; available across all projects
- `.mcp.json` at the project root — project-scoped; check in for team sharing

**Quickest way — CLI:**

```bash
claude mcp add --transport stdio verevoir \
  --env GITHUB_TOKEN=ghp_... \
  --env NOTION_API_KEY=ntn_... \
  -- npx -y @verevoir/mcp
```

Add `--scope user` to write to `~/.claude.json`; the default writes to the current project.

**Or edit `.mcp.json` directly:**

```json
{
  "mcpServers": {
    "verevoir": {
      "command": "npx",
      "args": ["-y", "@verevoir/mcp"],
      "alwaysLoad": true,
      "env": {
        "GITHUB_TOKEN": "ghp_...",
        "NOTION_API_KEY": "ntn_..."
      }
    }
  }
}
```

`alwaysLoad: true` (Claude Code v2.1.121+) forces all tools into context at session start so `read_file` / `grep` / `find_symbol` are reflex-reachable without a `ToolSearch` step. Omit it on older versions — the flag is silently ignored.

**Reload:** restart Claude Code, or run `claude --resume` (it spawns a fresh process that re-reads the config). Check server status with `/mcp` inside a session.

---

## Warp

**Config file:** `~/.warp/.mcp.json` (global) or `.warp/.mcp.json` at the project root (project-scoped).

**UI path:** Settings → Agents → MCP servers → `+ Add` → CLI Server.

```json
{
  "mcpServers": {
    "verevoir": {
      "command": "npx",
      "args": ["-y", "@verevoir/mcp"],
      "env": {
        "GITHUB_TOKEN": "ghp_...",
        "NOTION_API_KEY": "ntn_..."
      }
    }
  }
}
```

**Reload:** click Start next to the server in Settings → Agents → MCP servers. Global servers auto-spawn by default; project-scoped ones may require enabling the `Auto-spawn servers from third-party agents` toggle.

**Recommended:** disable `Autodetect agent prompts` and `Active AI` under Warp Agent settings to keep verevoir operating as a passive tool surface rather than an always-on assistant.

---

## Cursor

**Config files:**

- `.cursor/mcp.json` at the project root — project-scoped
- `~/.cursor/mcp.json` — global, available across all projects

```json
{
  "mcpServers": {
    "verevoir": {
      "command": "npx",
      "args": ["-y", "@verevoir/mcp"],
      "env": {
        "GITHUB_TOKEN": "ghp_...",
        "NOTION_API_KEY": "ntn_..."
      }
    }
  }
}
```

**Reload:** open the Cursor command palette and run `MCP: Restart MCP Server`, or restart Cursor. Toggle the server on/off from the Customize sidebar without removing the config entry.

---

## Gemini CLI

**Config file:** `~/.gemini/settings.json`.

```json
{
  "mcpServers": {
    "verevoir": {
      "command": "npx",
      "args": ["-y", "@verevoir/mcp"],
      "env": {
        "GITHUB_TOKEN": "ghp_...",
        "NOTION_API_KEY": "ntn_..."
      },
      "trust": true
    }
  }
}
```

The `trust` field (boolean, optional) suppresses per-tool confirmation prompts. The server config also accepts `timeout` (ms), `cwd`, `includeTools`, and `excludeTools`.

**Reload:** restart the Gemini CLI session.

> **Verify:** the `mcpServers` key name and `trust` field were confirmed from the Gemini CLI source (`MCPServerConfig` class, `@google/gemini-cli-core`). If the installed version differs, cross-check against the [Gemini CLI docs](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/configuration.md).

---

## OpenAI Codex CLI

> **Verify against [Codex CLI docs](https://github.com/openai/codex/blob/main/codex-cli/README.md):** a canonical MCP config example was not available in the public documentation at time of writing. The shape below follows the standard stdio MCP convention that Codex CLI is expected to support; confirm the exact key names and file path against the current docs before relying on it.

Expected config file: `~/.codex/config.toml` (or `config.json` — check the docs).

```toml
[mcp_servers.verevoir]
command = "npx"
args    = ["-y", "@verevoir/mcp"]

[mcp_servers.verevoir.env]
GITHUB_TOKEN    = "ghp_..."
NOTION_API_KEY  = "ntn_..."
```

**Reload:** restart the Codex CLI session.

---

## opencode

**Config file:** `opencode.json` (or `opencode.jsonc`) at the project root, or in `~/.config/opencode/opencode.json` for global config.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "verevoir": {
      "type": "local",
      "command": ["npx", "-y", "@verevoir/mcp"],
      "enabled": true,
      "environment": {
        "GITHUB_TOKEN": "ghp_...",
        "NOTION_API_KEY": "ntn_..."
      }
    }
  }
}
```

Note: opencode uses `"type": "local"` (not `"stdio"`) and `"command"` takes a full array (command + args combined); the env key is `"environment"`, not `"env"`.

**Reload:** restart opencode. Tools become available immediately on next launch.

---

## Cline (VS Code extension)

Cline stores its MCP config in a dedicated settings file managed by the extension. Open it via:

**Cline toolbar → MCP Servers icon → Configure tab → Configure MCP Servers**

This opens the JSON file; add an entry under `mcpServers`:

```json
{
  "mcpServers": {
    "verevoir": {
      "command": "npx",
      "args": ["-y", "@verevoir/mcp"],
      "env": {
        "GITHUB_TOKEN": "ghp_...",
        "NOTION_API_KEY": "ntn_..."
      },
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

`autoApprove` is a list of tool names that run without a confirmation prompt. Leave it empty to approve every call manually, or add specific tool names (e.g. `["read_file", "grep", "find_symbol"]`) for read-only tools.

**Reload:** changes take effect immediately; Cline restarts the server automatically on save.

---

## Continue (VS Code / JetBrains extension)

Continue uses a YAML config file. The default path is `~/.continue/config.yaml`; a project-level override lives at `.continue/config.yaml` in the repo root.

```yaml
mcpServers:
  - name: verevoir
    command: npx
    args:
      - -y
      - '@verevoir/mcp'
    env:
      GITHUB_TOKEN: 'ghp_...'
      NOTION_API_KEY: 'ntn_...'
```

**Reload:** Continue picks up config changes on restart. In VS Code, use the `Continue: Reload Config` command from the command palette.

---

## Zed

**Config file:** Zed's main `settings.json` (open it with `zed: open settings file` from the command palette, or via `agent: add context server` for a guided modal).

```json
{
  "context_servers": {
    "verevoir": {
      "command": "npx",
      "args": ["-y", "@verevoir/mcp"],
      "env": {
        "GITHUB_TOKEN": "ghp_...",
        "NOTION_API_KEY": "ntn_..."
      }
    }
  }
}
```

**Reload:** Zed reloads `settings.json` automatically on save; no restart needed.
