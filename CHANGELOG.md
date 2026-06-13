# Changelog

## 0.22.0 — 2026-06-13

**`write_file` / `edit_file`: `branch` + `commitMessage` are now optional** (STDIO-302). They're only used for GitHub commits — filesystem and Notion writes ignore them — so requiring them on every call was a smell (required-but-ignored). They're now optional in the schema; a **GitHub** source still gets a clear error if either is missing, and filesystem / Notion callers simply omit them. No behaviour change for GitHub callers that already passed both.

## 0.21.0 — 2026-06-12

**New: `delegate` tool — the coordinator→worker connector** (STDIO-345). `delegate({ prompt })` hands a self-contained sub-task to this project's configured **worker model** (any OpenAI-compatible chat endpoint) and returns its result — so the model you're talking to can offload bounded work to a cheaper worker. The prompt is self-contained: the worker sees only it, not the conversation.

- **Zero new dependency** — a plain `fetch` POST to the worker's `/chat/completions` (fetch is global in Node ≥20). Optional `system` and per-call `model` overrides.
- **Never throws** — a missing or unreachable worker returns a short, actionable notice, so the coordinator can relay or repair rather than crash.
- Worker configuration is **project-specific** (env).

## 0.20.0 — 2026-06-12

**`provision` gains the capability axis — light, provider-agnostic** (STDIO-339). The tool now also surfaces the **pre-built capabilities** that may fit the work, alongside the practices, in the same call. So `provision` answers both halves: _what you can run_ and _what you're held to_.

- **Retrieval is the embedding bin** (`@verevoir/recipes` `buildCapabilityIndex`) over the guardrails `corpus/capabilities`, top-K, advisory — the model picks or ignores. **Embedding-only: no reasoning/narrowing call**, so it's provider-agnostic on the reasoning front.
- **Zero new dependency.** The embedder is a hosted **OpenAI-compatible `/embeddings`** call over plain `fetch` (global in Node ≥20) — no onnxruntime, no SDK. Configure `AIGENCY_EMBEDDINGS_URL` / `AIGENCY_EMBEDDINGS_API_KEY` (falls back to `OPENAI_API_KEY`) / `AIGENCY_EMBEDDINGS_MODEL` (default `text-embedding-3-small`). Point it at OpenAI, Mistral, DeepSeek, Voyage, or any compatible endpoint. Corpus vectors are embedded once and cached by recipes; per call it's one short query embed.
- **Degrades cleanly:** no embeddings endpoint configured → the capability section is simply omitted and practices still return; a retrieval error never blocks the practices. The heavier local embedder (onnxruntime) can be swapped in behind the same seam if offline retrieval is ever needed.

## 0.19.0 — 2026-06-12

**New: `provision` tool — "consult the bar" as one triggered hop** (STDIO-326). The diagnostic: a floor model coding through the MCP never consults governance — not because it can't see `find_governance`, but because a weak model won't run a multi-call scavenger hunt (find the index → read each file) unprompted. `provision({ prose })` collapses that to one call that returns the **practices the work is held to as text**: the foundational floor always (no model call), plus concern-specific practices when `ANTHROPIC_API_KEY` is set (one reasoning classification via `@verevoir/recipes` → `@verevoir/llm`). Practice bodies are read from the guardrails corpus (`AIGENCY_GUARDRAILS_URL` override). It degrades rather than erroring — an unreadable source or a failed tagging call falls back to ids / the floor.

- **`instructions.md` now triggers it.** A new "Before you change code, consult the bar" step makes calling `provision` a precondition for changing code — the trigger a weak model lacked — and tells the coordinator to pass the returned frame into any worker it spawns (a floor sub-agent can't be hooked; the bar has to travel in its prompt).
- Adds `@anthropic-ai/sdk` as a dependency (peer of `@verevoir/llm`, which `@verevoir/recipes` pulls) for the concern-tagging call.
- The capability axis (prose→capabilities via the embedding bin) is intentionally not here — it pulls a heavy local embedder, a separate placement decision.

## 0.18.0 — 2026-06-08

**Readable tool output** (STDIO-315). Tool results now render through a shared `jsonText` helper that pretty-prints structured data and expands escaped control sequences (`\n`, `\t`, `\"`) — so multi-line string fields (file content, card bodies, diffs, commit messages) show as real newlines and quotes for the consumer (the LLM, and the human watching) instead of the literal `\n` / `\"` that `JSON.stringify` emits. All `source` + `workflow` tool results route through it. Output favours readability over round-trippable JSON; its only consumer reads it, it isn't re-parsed.

## 0.17.1 — 2026-06-08

**Fix: large files no longer crash `find_symbol` / `code_graph`** (STDIO-313). Picks up `@verevoir/context` 0.11.1: tree-sitter's `parse` threw `Invalid argument` for any source over ~32KB (common in real repos / vendored deps) and that crashed the whole symbol/graph search; the buffer is now sized to the source and a single file's parse failure degrades to empty. No code change here — dependency bump only. Verified end-to-end against the cpu8 kata (find_symbol resolves `KataApi` in all 3 defining files, no crash).

## 0.17.0 — 2026-06-08

**Multi-language code graph** (STDIO-313). Bumps `@verevoir/context` to `^0.11.0` and adds the tree-sitter grammars for **Python, Java, C#, Go, Scala, C and C++** as direct dependencies, so `find_symbol` and `code_graph` work across those languages, not just TypeScript/TSX/JavaScript. The grammars are _optional peer deps_ of `@verevoir/context`, so the MCP server — the package that actually loads them at runtime — must depend on them itself. Pinned to versions that peer `tree-sitter` ^0.21 (c/cpp exact at 0.23.2) so the install resolves under a strict CI resolve, no `--legacy-peer-deps`. No code change — `graph.ts` / `tools/source.ts` already call the language-agnostic API. Kotlin deferred (STDIO-316).

## 0.13.0 — 2026-06-04

**Skill parsing moves to `@verevoir/recipes`** (STDIO-278). The inline recipe parser added in 0.12.0 is replaced by a dependency on the new public `@verevoir/recipes` library, so the format definition is shared with the aigency web app rather than ported. No behaviour change — the same descriptors parse the same way and register as the same prompts. Removes `src/skills.ts` and its unit tests (now covered in the library). `tools/skills.ts` imports `parseSkill` / `isReasoningSkill` / `renderSkillPrompt` from `@verevoir/recipes`.

## 0.12.0 — 2026-06-04

**New: reasoning skills exposed as MCP prompts** (STDIO-277). At startup the server loads the guardrails skill corpus (`corpus/skills/*.md`, with a legacy `skills/` fallback) and registers each **reasoning** skill as an MCP prompt — the prompt returns the skill's instructions plus the supplied arguments as a user message, so the host model executes it. Deterministic (handler-backed) skills are not registered; the host typically already has those capabilities. The corpus source defaults to the canonical guardrails repo, overridable with `AIGENCY_GUARDRAILS_URL`. Loading is best-effort: a missing `GITHUB_TOKEN` or unreachable source leaves the server running with its tools and no skill prompts. `createServer` is now async (skill loading happens at startup). Skill parsing is a minimal in-repo port; a shared `@verevoir/skills` extraction so the web app and the server share one parser is the follow-up.

## 0.11.0 — 2026-05-30

Wire the Obsidian Kanban WorkflowAdapter (STDIO-186): `boardUrl`s that are an absolute path or `file://` URL route to `@verevoir/workflows/obsidian` (local board `.md`; lanes are columns; the linked note is the card source of truth; no creds; optional `OBSIDIAN_*` tuning env vars read inside the adapter at call time). Bumps `@verevoir/workflows` to `^0.5.0`. Tool `boardUrl` descriptions updated across all 8 workflow tools; README and llms.txt extended with the Obsidian routing line and prerequisites.

## 0.10.0 — 2026-05-29

**Doctrine + write-tool descriptions firmed to prefer the MCP over shell/built-ins** (STDIO-157, the original thrust of the card now that 0.8.0/0.9.0 made the cache claims true). No behaviour change — this sharpens how the server presents so an agent reaches for the MCP instead of reflexive `grep`/`sed`/`cat` or the built-in Edit/Write.

- **`instructions.md` lede is now imperative and splits reads from writes.** Writes through the MCP are the **firm rule** — a bypassing write (shell redirection, `sed -i`, built-in Edit/Write on a covered path) leaves the shared `@verevoir/context` cache stale and _wrong_ for the rest of the session, so later reads/searches serve pre-write content. Reads stay a strong preference (a bypassed read only misses the cache + index benefit). Mirrors the priority reframe on STDIO-157: a bypassed write corrupts state, a bypassed read only forgoes a benefit.
- **Fixed a now-false claim in the File-workflow section.** It still said `grep` / `find_symbol` "see only content already pulled by `read_file`, so read first" — untrue since 0.4.0's cold scan (and contradicted by the tool descriptions themselves). It now states they scan the whole source on demand and need no prior `read_file`, so the doctrine no longer advertises a limitation that doesn't exist and nudges agents back to shell.
- **`write_file` / `edit_file` descriptions** now lead with "prefer over the built-in Write/Edit (and shell redirection) for a covered path" and spell out the cache-corruption rationale, matching the read-side tools' existing "prefer over the built-in Read / shell grep" steer.

Pure doc/description change — no dependency bump, no tool-surface change. The deeper cache-key follow-up is STDIO-164.

## 0.9.0 — 2026-05-29

**Source reads and writes are now cache-correct** (STDIO-157 / STDIO-163). Two fixes to how the source tools interact with the shared `@verevoir/context` store that `grep` / `find_symbol` warm:

- **`read_file` reads through the cache.** It now wraps the adapter with `wrapWithCache` instead of calling it raw, so a read is served from / populates the shared `ContextStore` — making its "reads are cached… warms the index" contract true, and warming the content index for later `grep` / `find_symbol`.
- **Writes invalidate the cache.** `write_file` / `edit_file` drop the written file from the shared store (content + symbols, default-ref and branch scope) after writing, so a search after a write re-fetches and re-indexes rather than serving pre-write content. Previously a warm-then-edit served stale results.

No tool-surface change. Uses existing `@verevoir/context` `^0.9.0` APIs (`wrapWithCache`, `invalidateItem`) — no dependency bump. (A primary/canonical cache key that collapses the dual-scope invalidate is the follow-up, STDIO-164.)

## 0.8.0 — 2026-05-28

- **New: `edit_file` tool** (STDIO-122) — surgical `oldString`/`newString` edits through the cached adapter: read the file, replace an exact unique substring (or every occurrence with `replaceAll`), write it back, and repopulate the read cache, keeping the read→edit→write cycle in-toolchain across local, GitHub, and Notion sources. Errors clearly on no-match, ambiguous match, and empty/identical strings.
- **Input hardening** (STDIO-135): `manifestPath` throws on a `--manifest` with no path (or a flag value) instead of silently starting in no-project mode; `classifySourceUrl` matches `www.` and `http` GitHub URLs (mirrors the Notion matcher); `update_card` strips undefined patch keys at the boundary — clean payloads and protection for any future adapter (the Notion + Trello adapters already ignore undefined).
- Picks up `@verevoir/context` 0.9.1 (the `wrapWithCache` stale-read fix) via the existing `^0.9.0` range.

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
