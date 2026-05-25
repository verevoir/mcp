# Changelog

## 0.3.2 — 2026-05-25

**Operating doctrine packaged as a doc, loaded into `instructions` on connect** (STDIO-85). The server-level `instructions` (added in 0.3.1) move from an inline string literal to a packaged `instructions.md` loaded at startup — editable as a doc, and broader than tool usage:

- Now states the operating doctrine, not just how to call tools: project record + work tracker live in Notion / on the board (reach them via the tools); **work-shaped items are cards, not side-notes**; **fix the source, not the leaf**.
- `loadInstructions()` reads `instructions.md` (shipped via package `files`), resolved relative to the module so the same path works from both source and `dist`, with a graceful fallback if the doc is ever missing.

Exposing the doc as an MCP resource and composing project-specific doctrine from the `aigency.json` manifest / a Notion page remain follow-ups (STDIO-85 v1).

## 0.3.1 — 2026-05-24

**Tools now describe themselves as the front door** (STDIO-36). No change to what the tools _do_ — this sharpens how they present to the model so an agent reaches for them instead of its built-in filesystem/shell tools.

- Added a server-level `instructions` string (surfaced to the model by MCP clients): declares verevoir the preferred surface for reading files + project context, explains the one-URL/three-backend routing (local path / GitHub / Notion), and spells out the `get_repo_tree` → `read_file` → `grep`/`find_symbol` warm-then-search workflow.
- Rewrote every source-tool description to lead with when-to-use and a preference over the native `Read`/`grep`/`find`, make local-filesystem paths first-class rather than a buried afterthought, and reframe the `grep`/`find_symbol` cache requirement as a workflow rather than a limitation.
- De-Trello'd the workflow tools: `boardUrl` now documents Trello board URLs _and_ Notion database URLs; `list_columns`/`list_cards` describe the kanban-or-Notion work tracker; `update_card.body` warns that it replaces the whole body (and on Notion archives nested child pages).

Complements the 0.1.1 `alwaysLoad` fix: that forced the tools to load; this makes the model prefer them once loaded.

## 0.3.0 — 2026-05-24

**Notion adapter wired into the router** (Trello-42). Notion now joins GitHub and the local filesystem as a first-class source surface, and joins Trello as a first-class workflow surface.

- `pickSourceAdapter` recognises `https://www.notion.so/<page>` (and `notion.so` variants) and dispatches to the cached `@verevoir/context/notion` drop-in. Tools `read_file` / `list_files` / `get_repo_tree` / `grep` / `find_symbol` / `write_file` work against Notion pages out of the box.
- `pickWorkflowAdapter` recognises notion.so URLs as databases and dispatches to `@verevoir/workflows/notion`. Tools `list_columns` / `list_cards` / `get_card` / `create_card` / `update_card` / `move_card` / `list_comments` / `add_comment` work against Notion databases.
- `resolveSourceEnv` and `resolveWorkflowEnv` expect `NOTION_API_KEY` in the environment for Notion routing; clear error messages on missing keys.

**Dependency bumps**:

- `@verevoir/context` → `^0.4.0` (cached Notion drop-in).
- `@verevoir/sources` → `^0.4.0` (Notion source adapter).
- `@verevoir/workflows` → `^0.3.0` (Notion workflow adapter).
- **New**: `@notionhq/client@^5.22.0` as a direct dep — same pattern as tree-sitter (the substrate libraries' Notion subpaths require it).

## 0.2.0 — 2026-05-24

**Bumps to pick up substrate freshness validation** (Trello-33). No tool-surface changes, but the _behaviour_ of cached reads changes meaningfully:

- `@verevoir/sources` → `^0.3.0` — adds `isFresh` primitive (per-resource freshness probe; GitHub via Contents API sha compare, FS via re-hash).
- `@verevoir/context` → `^0.3.0` — `wrapWithCache` becomes read-through-with-validation gated by `validationTtlMs` (default 10s). Cache entries grow `{ content, version, cachedAt }`.
- `@verevoir/workflows` → `^0.2.0` — adds `isCardFresh` to the WorkflowAdapter; Trello via `?fields=dateLastActivity` single-field GET.

**What changes for users of the MCP server:** cached `read_file` reads now self-validate against the upstream after the TTL grace window (default 10s) — long-running MCP processes no longer return forever-stale content from the in-process cache. The window is configurable when consumers wrap their own adapters via `@verevoir/context/wrapWithCache`. Trello cache (when wired) gets the same treatment.

## 0.1.1 — 2026-05-24

- Docs: README + llms.txt recommend `"alwaysLoad": true` on the verevoir entry in Claude Code config (v2.1.121+). Without it, schemas are deferred behind `ToolSearch` and lose at reflex against always-on shell tools, defeating the cache + freshness layer.

## 0.1.0 — 2026-05-24

Initial release.

- `@verevoir/mcp` — MCP server exposing the Verevoir substrate as Claude-Code-usable tools. Stdio transport. Bin entry `verevoir-mcp`.
- 6 source tools (`read_file`, `list_files`, `get_repo_tree`, `grep`, `find_symbol`, `write_file`) backed by `@verevoir/context/github` + `@verevoir/context/fs`. URL-pattern routing.
- 8 workflow tools (`list_columns`, `list_cards`, `get_card`, `create_card`, `update_card`, `move_card`, `list_comments`, `add_comment`) backed by `@verevoir/workflows/trello`.
- Auth via env vars (`GITHUB_TOKEN`, `TRELLO_API_KEY` + `TRELLO_API_TOKEN` + `TRELLO_REFERER`). Per-tool failure with clear messages when required env is missing.
- 11 unit tests covering URL routing across source kinds + the unsupported-URL throw path.
