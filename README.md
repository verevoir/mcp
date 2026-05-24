# @verevoir/mcp

MCP server exposing the Verevoir substrate as Claude-Code-usable tools. Cached file reads, tree-sitter symbol search, and kanban / issue / objective operations behind one stdio MCP process.

## Purpose

Lets an LLM agent (or anyone driving Claude Code) work against multiple sources — GitHub repos, local filesystems, Trello boards — through one stable tool surface. Reads are cached via `@verevoir/context`; writes go through the underlying adapter and populate the cache so subsequent reads see the new content without a refetch.

Sibling to [`@verevoir/sources`](https://github.com/verevoir/sources), [`@verevoir/context`](https://github.com/verevoir/context), and [`@verevoir/workflows`](https://github.com/verevoir/workflows). This package wires them together as an MCP server.

## Prerequisites

- Node `>=20`.
- One or more of:
  - **GitHub PAT** — fine-grained, with `Contents: Read + Write` on whichever repos you want the tools to touch. Add `Pull requests: Read + Write` and `Workflows: Read + Write` if you'll expand the tool surface later.
  - **Trello Power-Up** — created at https://trello.com/power-ups/admin. From the Power-Up's **API Key** tab, generate the API key + the user token (the "Token" hyperlink on the same page). Note the allowed-origin URL — the MCP server must send it as the `Referer` or Trello returns 401.

## Install

### Option A — via npm (recommended for stable use)

```bash
npm install -g @verevoir/mcp
```

Or invoke via `npx` (no global install).

### Option B — local path (recommended while iterating on the server)

Clone, build, and point your MCP config at the local `dist/bin.js`. Skips the publish cycle on every server change.

```bash
git clone git@github.com:verevoir/mcp.git
cd mcp
npm install
npm run build
```

## Configuration in Claude Code

Add to `~/.claude/mcp.json`:

### Option A — npm

```json
{
  "mcpServers": {
    "verevoir": {
      "command": "npx",
      "args": ["-y", "@verevoir/mcp"],
      "alwaysLoad": true,
      "env": {
        "GITHUB_TOKEN": "ghp_...",
        "TRELLO_API_KEY": "...",
        "TRELLO_API_TOKEN": "...",
        "TRELLO_REFERER": "https://your-power-up-origin"
      }
    }
  }
}
```

### Option B — local path

```json
{
  "mcpServers": {
    "verevoir": {
      "command": "node",
      "args": ["/absolute/path/to/mcp/dist/bin.js"],
      "alwaysLoad": true,
      "env": {
        "GITHUB_TOKEN": "ghp_...",
        "TRELLO_API_KEY": "...",
        "TRELLO_API_TOKEN": "...",
        "TRELLO_REFERER": "https://your-power-up-origin"
      }
    }
  }
}
```

Restart Claude Code (the MCP server loads at session start; `claude --resume` works too — it spawns a new process which re-reads `mcp.json`).

#### Why `"alwaysLoad": true`

Without this flag, Claude Code auto-defers MCP tool schemas when total tool definitions exceed ~10% of the context window — only tool _names_ are sent up front; the model must call `ToolSearch` to load each schema before using it. That extra step makes the verevoir tools lose against always-on shell reflex (`grep`, `cat`, `find`) at the moment of choosing a tool — defeating the cache + freshness benefits of the MCP layer. `alwaysLoad: true` (Claude Code v2.1.121+) forces every tool from this server into the session at startup, so `read_file` / `grep` / `find_symbol` / `list_cards` are reflex-reachable. Older Claude Code versions ignore the flag (no breakage). The cost is ~2–5KB of context — worth it.

Env vars are read per-tool: GitHub tools only need `GITHUB_TOKEN`; Trello tools only need the three `TRELLO_*` vars. The server starts regardless of which are set — missing-env errors surface at tool-call time with clear messages naming the variable.

## Sanity check

Once configured + restarted, ask Claude to call `list_columns` against your Trello board. You should get an array of columns back. If you see "TRELLO_API_KEY not set" or "Trello returned 401: invalid key", the auth env or the Power-Up referer mismatch is the cause.

## Tools

### Source tools (file-shape sources)

All take a `sourceUrl` (`https://github.com/owner/repo` or absolute filesystem path) and route to the appropriate cached adapter.

| Tool            | Args                                                     | Returns            |
| --------------- | -------------------------------------------------------- | ------------------ |
| `read_file`     | `{ sourceUrl, path, ref? }`                              | `{ content, sha }` |
| `list_files`    | `{ sourceUrl, prefix?, ref? }`                           | `DirEntry[]`       |
| `get_repo_tree` | `{ sourceUrl, ref? }`                                    | `RepoTree`         |
| `grep`          | `{ sourceUrl, pattern, ref?, ignoreCase?, maxResults? }` | `GrepHit[]`        |
| `find_symbol`   | `{ sourceUrl, name, ref?, kind? }`                       | `SymbolHit[]`      |
| `write_file`    | `{ sourceUrl, path, content, branch, commitMessage }`    | `{ ok: true }`     |

`grep` and `find_symbol` operate on **cached** content only — call `read_file` first on any files you want searchable. The cache is per-process, lazy-population.

### Workflow tools (kanban / issue / objective sources)

All take a `boardUrl` (today: `https://trello.com/b/<id>`).

| Tool            | Args                                                                  | Returns        |
| --------------- | --------------------------------------------------------------------- | -------------- |
| `list_columns`  | `{ boardUrl }`                                                        | `Column[]`     |
| `list_cards`    | `{ boardUrl, columnId?, assigneeId?, labelId?, parentId? }`           | `Card[]`       |
| `get_card`      | `{ boardUrl, cardId }`                                                | `Card`         |
| `create_card`   | `{ boardUrl, columnId, title, body?, labelIds?, dueDate? }`           | `Card`         |
| `update_card`   | `{ boardUrl, cardId, title?, body?, columnId?, labelIds?, dueDate? }` | `{ ok: true }` |
| `move_card`     | `{ boardUrl, cardId, toColumnId }`                                    | `{ ok: true }` |
| `list_comments` | `{ boardUrl, cardId }`                                                | `Comment[]`    |
| `add_comment`   | `{ boardUrl, cardId, body }`                                          | `{ ok: true }` |

## What this is NOT

- Not a sync engine. Each tool is one operation; cross-backend mirroring lives elsewhere.
- Not a code editor. Reads + writes pass through adapters; no in-memory text editing primitives.
- Not opinionated about backends. URL routing picks the implementation; the protocol stays uniform.

## See also

- [`@verevoir/sources`](https://github.com/verevoir/sources) — file-source contracts + GitHub + FS adapters.
- [`@verevoir/context`](https://github.com/verevoir/context) — content + symbol cache; cached drop-in subpaths.
- [`@verevoir/workflows`](https://github.com/verevoir/workflows) — workflow-source contracts + Trello adapter.
- [`@verevoir/llm`](https://github.com/verevoir/llm) — provider-agnostic LLM call surface.

## License

Apache-2.0.
