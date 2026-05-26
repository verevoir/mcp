# Changelog

## 0.7.0 — 2026-05-26

**Workflow reads now cached.** `pickWorkflowAdapter` wraps the Trello / Notion adapters with `wrapWorkflowWithCache` (context 0.9.0), so `list_columns` / `list_cards` / `get_card` / `list_comments` / `list_custom_fields` get read-through caching with cheap `isCardFresh` revalidation past the ~10s grace window (one `pages.retrieve` `last_edited_time` compare on Notion). Writes (`create_card` / `update_card` / `move_card` / `add_comment`) pass through and invalidate the touched card + list views. The workflow twin of the cached source subpaths — collapses correlated re-reads within a process. Default 10s TTL (tune via the wrapper if ever needed; even a sub-second window meaningfully de-dupes intra-process reads).

## 0.6.0 — 2026-05-26

Bumps `@verevoir/context` to `^0.9.0` — picks up `ContextStore.serialize()` (park/restore, 0.8.0) and `wrapWorkflowWithCache` (0.9.0). No tool-surface change: the cached source reads (`read_file` / `grep` / `find_symbol`) ride the latest cache, and the server dogfoods it driving boards + repos. Notion entries revalidate cheaply past the TTL grace window via the source adapter's `isFresh` (one `pages.retrieve` `last_edited_time` compare — no content re-fetch). Wiring `wrapWorkflowWithCache` into the workflow tools (cached `list_cards` / `get_card`) is a follow-up.

## 0.5.0 — 2026-05-26

**`list_cards` omits bodies by default** (STDIO-93). The tool gains `includeBody` (default **false**) and `limit`. Large boards / long-bodied DBs (e.g. an ADR database) previously returned every card's full Markdown body in one response and could overflow the model's tool-result budget; now list views are lean by default — read a single body with `get_card`, or pass `includeBody: true` when you really want them all. Bumps `@verevoir/workflows` to `^0.4.0` (which carries the `includeBody`/`limit` `CardFilter` options).

## 0.4.0 — 2026-05-26

**`grep` + `find_symbol` go cold** (STDIO-83). The tools no longer search only what `read_file` has already pulled in — they scan the **whole source on demand**, warming the shared cache as they go:

- `grep` → `grepSource(adapter, …)`: enumerates the routed source's tree (skipping vendored / build dirs), pulls every text file into the cache in parallel (bounded concurrency), then matches. Works for local paths, GitHub repos, and Notion alike via the routed adapter.
- `find_symbol` → `warmSource(adapter, …)` then `findSymbols`: same cold warm, then tree-sitter symbol search over the warmed content.
- Tool descriptions updated — the old "read the files you want to search first" instruction is gone; cold search needs no pre-`read_file`.

Bumps `@verevoir/context` to `^0.7.0` (the version exposing `grepSource` / `warmSource`).

## 0.3.5 — 2026-05-25

**Project doctrine composed from the manifest** (STDIO-85 v1, part 1). The server now reads the project pointer manifest (`aigency.json`, per ADR 023) at startup and composes a project-specific **## This project** section onto the universal doctrine — naming _this_ project's work tracker, project record, and ADR database as concrete Notion URLs, so the "read the board / put work on the board" steer resolves to real destinations instead of staying abstract.

- Manifest discovery follows ADR 023: `aigency.json` in the server's working directory, overridable with `--manifest <path>`. No manifest (or an unreadable / invalid one) → **no-project mode**: the server still starts with the universal doctrine only.
- `loadManifest` / `renderProjectDoctrine` / `composeInstructions` are pure and unit-tested; `createServer` wires them onto `loadInstructions()`.

Deferred to follow-ups: surfacing the work-tracker **id prefix** in the doctrine (needs a manifest-schema field or a Notion read), and fetching a designated Notion onboarding page at startup to inject verbatim (STDIO-85 v1, part 2 — startup network).

## 0.3.4 — 2026-05-25

**The board is the project's state** (STDIO-88 — second finding from the STDIO-86 cold runs). A cold sibling, given the full doctrine, still answered "what's your state?" from `git status` and declared "no work in flight." The doctrine said where work _lives_ and where to _put_ it, but never that the board is the answer to _reading_ state. Reworks the project-state section to lead with: read the work tracker first for state / in-progress / next; the local git tree + open PRs are the operational shell, not the project's state.

## 0.3.3 — 2026-05-25

**Working-discipline doctrine** (STDIO-87 — first finding from the STDIO-86 cold run). Adds a "Working discipline" section to `instructions.md`: trace work to the tracker (carry the item id through branch / commit / PR title), and keep changes single-purpose with stated verification. Generic by design — the project-specific prefix value and any house PR norms compose from the manifest in STDIO-85 v1.

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
