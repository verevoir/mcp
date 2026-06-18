# @verevoir/mcp

MCP server exposing the Verevoir foundation as Claude-Code-usable tools. Cached file reads, tree-sitter symbol search, and kanban / issue / objective operations behind one stdio MCP process.

## Purpose

Lets an LLM agent (or anyone driving Claude Code) work against multiple sources — GitHub repos, local filesystems, Notion workspaces, Trello boards, and Obsidian Kanban boards — through one stable tool surface. Reads are cached via `@verevoir/context`; writes go through the underlying adapter and populate the cache so subsequent reads see the new content without a refetch.

Sibling to [`@verevoir/sources`](https://github.com/verevoir/sources), [`@verevoir/context`](https://github.com/verevoir/context), and [`@verevoir/workflows`](https://github.com/verevoir/workflows). This package wires them together as an MCP server.

## Prerequisites

- Node `>=20`.
- One or more of:
  - **GitHub PAT** — fine-grained, with `Contents: Read + Write` on whichever repos you want the tools to touch. Add `Pull requests: Read + Write` and `Workflows: Read + Write` if you'll expand the tool surface later.
  - **Trello Power-Up** — created at https://trello.com/power-ups/admin. From the Power-Up's **API Key** tab, generate the API key + the user token (the "Token" hyperlink on the same page). Note the allowed-origin URL — the MCP server must send it as the `Referer` or Trello returns 401.
  - **Notion integration** — create one at https://www.notion.so/profile/integrations, then share the relevant pages / databases with the integration from Notion's "Connections" UI. The integration token (`ntn_…`) is what you set as `NOTION_API_KEY`.
  - **Obsidian Kanban** — no credentials required. Pass the absolute path (or `file://` URL) to a Kanban board `.md` as `boardUrl`. Optional tuning via env vars read at call time: `OBSIDIAN_VAULT_PATH`, `OBSIDIAN_ID_FIELD` (default `id`), `OBSIDIAN_CARD_FOLDER`, `OBSIDIAN_DATE_FIELD` (default `due`), `OBSIDIAN_TAGS_FIELD` (default `tags`).

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
        "TRELLO_REFERER": "https://your-power-up-origin",
        "NOTION_API_KEY": "ntn_..."
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
        "TRELLO_REFERER": "https://your-power-up-origin",
        "NOTION_API_KEY": "ntn_..."
      }
    }
  }
}
```

Restart Claude Code (the MCP server loads at session start; `claude --resume` works too — it spawns a new process which re-reads `mcp.json`).

#### Pointing the server at a project (`aigency.json`)

The server injects an operating doctrine into the model's context on connect. When it can find a project **pointer manifest** (`aigency.json`, per ADR 023), it appends a project-specific section naming _this_ project's work tracker, project record, and ADR database as concrete Notion URLs.

Discovery (per ADR 023): the server reads `aigency.json` from its **working directory**, overridable with a `--manifest <path>` arg. Add it after the script path:

```json
"args": ["/absolute/path/to/mcp/dist/bin.js", "--manifest", "/absolute/path/to/project/aigency.json"]
```

Without a manifest the server runs in **no-project mode** — it still starts and serves the universal doctrine; only the project-specific section is omitted.

#### Why `"alwaysLoad": true`

Without this flag, Claude Code auto-defers MCP tool schemas when total tool definitions exceed ~10% of the context window — only tool _names_ are sent up front; the model must call `ToolSearch` to load each schema before using it. That extra step makes the verevoir tools lose against always-on shell reflex (`grep`, `cat`, `find`) at the moment of choosing a tool — defeating the cache + freshness benefits of the MCP layer. `alwaysLoad: true` (Claude Code v2.1.121+) forces every tool from this server into the session at startup, so `read_file` / `grep` / `find_symbol` / `list_cards` are reflex-reachable. Older Claude Code versions ignore the flag (no breakage). The cost is ~2–5KB of context — worth it.

Env vars are read per-tool: GitHub tools only need `GITHUB_TOKEN`; Trello tools only need the three `TRELLO_*` vars; Notion tools (both source and workflow) only need `NOTION_API_KEY`. The server starts regardless of which are set — missing-env errors surface at tool-call time with clear messages naming the variable.

## Sanity check

Once configured + restarted, ask Claude to call `list_columns` against your Trello board. You should get an array of columns back. If you see "TRELLO_API_KEY not set" or "Trello returned 401: invalid key", the auth env or the Power-Up referer mismatch is the cause.

## Prompts

The server also registers the guardrails **reasoning skills** (`corpus/skills/*.md`) as MCP prompts. Invoking a prompt returns the skill's instructions plus your supplied arguments as a message for **your** model to execute — so a skill runs on the host's own tokens. Deterministic (handler-backed) skills are not registered as prompts; the host usually already has those capabilities. The corpus source defaults to the canonical guardrails repo and is overridable with `AIGENCY_GUARDRAILS_URL`; loading is best-effort, so a missing `GITHUB_TOKEN` simply means no skill prompts are registered. Requires an MCP client that supports prompts.

## Tools

### Source tools (file-shape sources)

All take a `sourceUrl` and route to the appropriate cached adapter:

- `https://github.com/owner/repo` → cached GitHub adapter.
- `https://www.notion.so/<workspace>/<page-id>` (or any notion.so URL form) → cached Notion adapter. Pages become "files"; child pages become "subdirectories"; reads/writes traverse `path` through the page tree.
- Absolute filesystem path (or `file://...`) → cached FS adapter.

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

All take a `boardUrl`:

- `https://trello.com/b/<id>` → Trello adapter.
- `https://www.notion.so/<workspace>/<db-id>?v=...` (or any notion.so URL form pointing at a database) → Notion adapter. Rows become `Card`s; auto-detects which property is the status / column from the database schema.
- Absolute filesystem path or `file://` URL → Obsidian Kanban adapter. Local board `.md`; `## headings` are columns; `- [ ] [[Note]]` wikilinks are cards; the linked note is the card source of truth; no credentials required.

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

### Governance tools

Surface the project's governance — the ADRs / principles / glossary in the project record, and the **practices** (quality standards) in the guardrails corpus.

| Tool              | Args                              | Returns                                                                                |
| ----------------- | --------------------------------- | -------------------------------------------------------------------------------------- |
| `find_governance` | `{ query? }`                      | A scannable, narrowable index of governance entries (title + how to `read_file` each). |
| `provision`       | `{ prose?, concerns?, autoTag? }` | The **practices held to** + the **capabilities that may fit**, in one call.            |

`provision` reads from the guardrails corpus (override the source with `AIGENCY_GUARDRAILS_URL`).

- **Practices** (the bar): the foundational floor always comes back in full, with no model call. How the concern practices are chosen depends on the caller (STDIO-348):
  - **default** — the floor plus a **menu** of the concern practices (id + one-line summary). A capable coordinator sees the whole task, so it narrows the menu itself and calls back with `concerns: ['id', …]` to pull the bodies — no key, and it out-selects an isolated classifier (which only ever sees a prose blurb).
  - **`concerns: [...]`** — the floor plus exactly those concern bodies: a complete frame you can inject into a worker.
  - **`autoTag: true`** — for a weak/headless caller with no coordinator to narrow: select the concerns in-MCP via the configured reasoning provider (needs its key, e.g. `ANTHROPIC_API_KEY`). `delegate` uses this for its worker. The only path that needs a key.
- **Capabilities** (pre-built procedures, advisory): retrieved via an embedding bin when an embeddings endpoint is configured — `AIGENCY_EMBEDDINGS_API_KEY` (falls back to `OPENAI_API_KEY`), `AIGENCY_EMBEDDINGS_URL` (default OpenAI; point at any OpenAI-compatible provider — Mistral / DeepSeek / Voyage / …), `AIGENCY_EMBEDDINGS_MODEL` (default `text-embedding-3-small`). No endpoint → the capability section is omitted.

Both halves degrade gracefully — an unreadable source, a failed tagging call, or a retrieval error falls back rather than erroring.

Every frame is prefixed with a **corpus trust-boundary banner** (STDIO-399): the governance is injected into the model's prompt, so the banner frames it as the bar for _standards_, not a channel for commands — an instruction embedded in a practice/capability body is a poisoning _finding_ to report rather than follow. When the corpus is loaded from a non-canonical `AIGENCY_GUARDRAILS_URL`, the banner discloses that provenance.

### Delegation

`delegate` hands a self-contained sub-task to this project's configured **worker model** and returns its result — for offloading bounded work from the coordinator to a cheaper worker. The worker is **configured per project** (env); with no worker configured the tool returns a short notice rather than erroring.

## Board card sync (CI)

The `card-sync` workflow moves a PR's work-tracker card through the board from the PR lifecycle — **opened → "In preview"**, **merged → "Done"** — keyed off the `<Namespace>-<id>` work-item id in the branch (STDIO-236). Deterministic and best-effort: an unknown card or missing config is logged and **never blocks the merge**.

To activate it, set two values **at the GitHub org level** (once, not per-repo — the credential should have one holder):

- **`NOTION_API_KEY`** — an org **secret**: the board's Notion integration token.
- **`BOARD_URL`** — an org **variable**: the board's Notion database URL, e.g. `https://www.notion.so/<database-id>`.

Until both are set the workflow step best-effort-skips (no token → exit 0), so it is inert and harmless.

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
