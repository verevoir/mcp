# Changelog

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
