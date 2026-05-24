# @verevoir/mcp

MCP server exposing the Verevoir substrate (cached file reads + tree-sitter symbol search + workflow operations) as tools usable from Claude Code and any other MCP-compatible client.

## Purpose

Lets an LLM agent (or anyone driving Claude Code) work against multiple sources — GitHub repos, local filesystems, Trello boards — through one stable tool surface, with read-through caching and symbol-level navigation provided by `@verevoir/context`.

Sibling to [`@verevoir/sources`](https://github.com/verevoir/sources), [`@verevoir/context`](https://github.com/verevoir/context), and [`@verevoir/workflows`](https://github.com/verevoir/workflows). This package is the glue that exposes them all as MCP tools.

## Install

```bash
npm install -g @verevoir/mcp
```

Or run via `npx @verevoir/mcp`.

## Configuration in Claude Code

Add to `~/.claude/mcp.json`:

```json
{
  "mcpServers": {
    "verevoir": {
      "command": "npx",
      "args": ["-y", "@verevoir/mcp"],
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

Restart Claude Code. The tools listed below become available.

Env vars are read per-tool — you only need the ones for the sources you actually use. GitHub tools work without Trello credentials and vice versa.

## Tools

### Source tools (file-shape sources)

All take a `sourceUrl` (either `https://github.com/owner/repo` or an absolute filesystem path like `/Users/me/proj`) and route to the appropriate cached adapter.

- **`read_file`** — `{ sourceUrl, path, ref? }` — cached read; subsequent calls for the same path serve from memory.
- **`list_files`** — `{ sourceUrl, prefix?, ref? }` — directory listing.
- **`get_repo_tree`** — `{ sourceUrl, ref? }` — full file tree.
- **`grep`** — `{ sourceUrl, pattern, ref?, ignoreCase?, maxResults? }` — substring search across **cached** content only (call `read_file` first to populate).
- **`find_symbol`** — `{ sourceUrl, name, ref?, kind? }` — tree-sitter symbol search across cached + parsed content.
- **`write_file`** — `{ sourceUrl, path, content, branch, commitMessage }` — commits via the GitHub contents API; for FS, writes to disk.

### Workflow tools (kanban / issue / objective sources)

All take a `boardUrl` (today: `https://trello.com/b/<id>`).

- **`list_columns`** — `{ boardUrl }`
- **`list_cards`** — `{ boardUrl, columnId?, assigneeId?, labelId?, parentId? }`
- **`get_card`** — `{ boardUrl, cardId }`
- **`create_card`** — `{ boardUrl, columnId, title, body?, labelIds?, dueDate? }`
- **`update_card`** — `{ boardUrl, cardId, title?, body?, columnId?, labelIds?, dueDate? }`
- **`move_card`** — `{ boardUrl, cardId, toColumnId }`
- **`list_comments`** — `{ boardUrl, cardId }`
- **`add_comment`** — `{ boardUrl, cardId, body }`

## What this is NOT

- Not a sync engine. Each tool is a single operation; cross-backend mirroring lives elsewhere.
- Not a code editor. Reads + writes go through adapters; no in-memory text editing primitives.
- Not opinionated about which board or repo you point at. URL routing decides the backend; the protocol is uniform.

## See also

- [`@verevoir/sources`](https://github.com/verevoir/sources) — file-source contracts + GitHub + FS adapters.
- [`@verevoir/context`](https://github.com/verevoir/context) — content + symbol cache, cached drop-in subpaths.
- [`@verevoir/workflows`](https://github.com/verevoir/workflows) — workflow-source contracts + Trello adapter.
- [`@verevoir/llm`](https://github.com/verevoir/llm) — provider-agnostic LLM call surface.

## License

Apache-2.0.
