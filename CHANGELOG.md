# Changelog

## 0.63.0 — 2026-06-30

- **Flame-chart a Claude Code run — `verevoir-audit-trace --from-claude-transcript`** (STDIO-502, "Route 1"). OTel gives Claude Code's cost _metrics_ but not a span _timeline_; this fills that gap, and works retroactively on any past session transcript. A new pure converter (`src/claude-transcript.ts`, `claudeTranscriptToSpans`) turns a Claude Code session transcript (JSONL) into the same `AuditSpan` shape the MCP's own cascade emits: each assistant turn with usage becomes a `model` span (model + token attributes, duration = the think+generate gap since the previous entry), and each `tool_use` block becomes a `tool` span parented to its turn (note derived from the tool args, duration running to the matching `tool_result`). Subagent (`isSidechain`) turns thread into the cascade automatically via `parentUuid`. The `--from-claude-transcript` flag on `verevoir-audit-trace` swaps the _source_ of spans; everything downstream (Chrome trace / OTLP / `--elide-notes` / `-o`) is reused unchanged. Zero dependencies.

## 0.62.0 — 2026-06-30

- **Live OTLP audit export — unify with Claude Code in one trace** (STDIO-502). When `OTEL_EXPORTER_OTLP_ENDPOINT` is set (and `AIGENCY_AUDIT` ≠ `off`), each audit span is POSTed live to `<endpoint>/v1/traces` in addition to the local JSONL — **fire-and-forget and fail-soft** (a slow/unreachable collector never blocks a tool). Because it's the standard OTel env, the MCP, **Claude Code** (`CLAUDE_CODE_ENABLE_TELEMETRY=1` + the same endpoint), and the aigency executor all land in **one trace**: stand up a throwaway collector for a session, then tear it down. The OTLP mapping moves to a shared `src/otlp.ts` used by both the live exporter and the `verevoir-audit-trace --otlp` file path, so the two are byte-identical.

## 0.61.0 — 2026-06-29

- **Uniform tier call path — Anthropic / Gemini / OpenAI-compat / local all resolve** (STDIO-467). Replaces the `tierModel` → `modelConnection` (compat-only) path with a new `tierChat` that resolves tiers through the llm library's uniform provider-adapter layer. Every provider that registers a `chat` fn (Anthropic, Gemini, OpenAI, DeepSeek, SambaNova, Mistral, and direct-compat endpoints) now works for any tier — closing the gap where `AIGENCY_MODEL_REASONING=opus` with `ANTHROPIC_API_KEY` silently returned null.

  **Per-tier triple.** Each tier (`reasoning` / `drafting` / `extraction`) is configured via three env vars: `AIGENCY_MODEL_<TIER>` (model name/id or family; unset → default), `AIGENCY_MODEL_<TIER>_URI` (optional direct OpenAI-compat endpoint), `AIGENCY_MODEL_<TIER>_KEY` (optional bearer key for that endpoint; KEY without URI is a no-op). When `_URI` is set the tier uses a direct OpenAI-compat fetch (validated on read); when not the model term resolves through the adapter catalog.

  **Defaults.** `AIGENCY_MODEL_REASONING` unset → `opus`; `AIGENCY_MODEL_DRAFTING` unset → `sonnet`; `AIGENCY_MODEL_EXTRACTION` unset → `haiku`. These resolve through whichever provider's catalog the term matches (e.g. `opus` → Anthropic when `ANTHROPIC_API_KEY` is set).

  **`AIGENCY_WORKER_*` deprecated** — `AIGENCY_WORKER_MODEL`, `AIGENCY_WORKER_URL`, `AIGENCY_WORKER_API_KEY` are now aliases for `AIGENCY_MODEL_EXTRACTION`, `AIGENCY_MODEL_EXTRACTION_URI`, `AIGENCY_MODEL_EXTRACTION_KEY`. Both forms work; the `AIGENCY_MODEL_EXTRACTION_*` vars take precedence. The `workerConfig()` export reads both.

  **Touches:** `src/tiers.ts` (new `tierChat`, `tierEnvConfig`, `TIER_DEFAULTS`, `TierChat` type), `src/tools/review.ts` (reasoning reviewer now drives the adapter's `ChatFn`; `reasoningChatFn` takes `TierChat`), `src/tools/delegate.ts` (`tier` param type `TierChat | null`; native-adapter path added alongside the existing raw-fetch path), `src/review-bin.ts` (`provisionRubric` takes `TierChat`; `run`'s `tier` dep takes `TierChat | null`). 16 new tier tests; all 492 pass.

  **Not in this PR:** guardrails env-docs update (flagged follow-on; single-repo scope).

## 0.60.2 — 2026-06-28

- **Audit log — per-span context notes and ambient run purpose** (STDIO-489). Adds `note?: string` and `purpose?: string` to `AuditSpan`. `note` is a zero-token, zero-model per-span label derived from the tool call's salient argument (`write_file`/`edit_file`/`read_file` → path; `grep` → pattern; `find_symbol` → name; `open_pull_request` → title; `delegate`/`dispatch`/`refine_start`/`search_start` → first line of the task/prompt, truncated to 120 grapheme clusters). `purpose` is an ambient run label read once from `AIGENCY_AUDIT_PURPOSE` and inherited by every child span via `SpanContext` / `childContext`. Both fields appear at `on` mode (not gated to `verbose`). **Guard rails:** note derivation never throws (bad args → no note); the cap is grapheme-cluster-safe via `Intl.Segmenter`; newlines are collapsed to a single space before the cap; the env var is also capped and trimmed. **Converter:** `verevoir-audit-trace` now includes `note` and `purpose` in Chrome Trace frame names (`name → note`) and in `args`, and as OTLP string attributes. New `--elide-notes` flag suppresses both fields from OTLP export for operators who treat prompt content as sensitive (addresses the `telemetry-excludes-sensitive-data` concern: path-derived notes are structural identifiers; prompt-derived notes are truncated excerpts of LLM prompt content and should be redacted when exporting to third-party OTLP backends). New exports: `deriveNote`, `truncateNote`, `resolveAuditPurpose`, `NOTE_MAX_CHARS`. 169 new tests; all 479 pass.

## 0.60.1 — 2026-06-28

- **Consume `@verevoir/llm` 0.17.0 — fixes the audit-log `verbose` cost double-count** (STDIO-487). Bumps the `@verevoir/llm` dependency from `^0.15.0` to `^0.17.0`, pulling in the `shapeUsage` fix (cached input tokens were priced twice — the ~80% cost overshoot) plus the capped HTTP-retry ladder (0.16.0). Cost attribution in the audit log's `verbose` mode (and any path that shapes usage via `@verevoir/llm`) is now correct. No mcp source change.

## 0.60.0 — 2026-06-28

- **Audit log — per-session JSONL trace of every tool call** (STDIO-486). New env var `AIGENCY_AUDIT` (`off` default / `on` / `verbose`) enables an append-only per-session JSONL file in `./aigency-audit/` (override with `AIGENCY_AUDIT_DIR`). A session is a burst of activity: a new file is started when the gap since the last entry exceeds 120 s (override with `AIGENCY_AUDIT_SESSION_GAP` seconds). Files are named by session-start ISO timestamp. Every entry is an OpenTelemetry-shaped span: `trace_id`, `span_id`, `parent_span_id`, `name`, `kind` (`capability` | `tool` | `model`), `start`, `end`, `duration_ms`. `verbose` mode adds `attributes`: `model`, `tokens_in`, `tokens_out`, `cached`, `cost`, and `cost_rollup` at the capability level. `delegate`, `dispatch`, and all loop (`refine` / `search`) tool handlers are instrumented — every tool call emits a span, and nested work (capability → tool → model) is threaded via `parent_span_id`. Zero-dep, zero-token: pure Node.js stdlib (`node:fs`, `node:crypto`, `node:path`). The `AIGENCY_METER` per-call param is unaffected (inline cost-in-result footer). New `SpanContext` / `childContext()` exported from `src/audit.ts` for downstream consumers. Existing metering double-count (cached tokens priced twice in `@verevoir/llm`'s `shapeUsage`) flagged for a separate `@verevoir/llm` PR — see note in PR description.

- **`verevoir-audit-trace` converter bin** (STDIO-486). A thin CLI bin (`verevoir-audit-trace <session.jsonl>`) converts a session JSONL file to Chrome Trace Event format JSON (open in speedscope.app / Perfetto / chrome://tracing for an interactive flame chart). `--otlp` emits OTLP-JSON instead. `-o <file>` writes to a file; default stdout. No runtime dependencies.

- **MCP client configuration docs** (STDIO-485). New `docs/clients.md` with per-client setup instructions for Claude Code, Warp, Cursor, Gemini CLI, OpenAI Codex CLI, opencode, Cline, Continue, and Zed. Universal stdio pattern first (command/args/env shape, project pointer); each client section covers config file location, exact JSON/YAML shape, and how to reload. The README "Configuration in Claude Code" section now links to the new page. Wording fix in README + llms.txt: "recommended (and only documented) way to point the server at a project" → "the way to point the server at project documentation and task trackers".

## 0.59.0 — 2026-06-26

- **Manifest discovery: `AGENTS.md` embedded block and multi-step precedence** (STDIO-483). The server now resolves its project pointer manifest through a four-step precedence chain (first that yields a usable manifest wins): **(1)** explicit `--manifest <path>` arg — unchanged behaviour, throws on a bad/missing flag value; if the path ends in `.md`, the `verevoir-mcp` fenced block is parsed. **(2)** `AGENTS.md` in the working directory, if it contains a fenced block whose info-string starts with `verevoir-mcp` — the block body is JSON-parsed as the manifest. **(3)** `verevoir-mcp.json` in the working directory (JSON). **(4)** `aigency.json` in the working directory (JSON) — legacy, permanent fallback. Each step degrades gracefully: a present-but-malformed source (bad JSON, missing block) is treated as absent and resolution continues; the only hard error remains a `--manifest` flag with no value or an explicit path that is broken. Governance `source` paths declared in the manifest are now resolved against the **winning source file's directory** (`AGENTS.md` / `verevoir-mcp.json` / `aigency.json`) rather than always the hard-coded `aigency.json` path, so relative-source pointers work correctly regardless of which file won. New pure helper `extractAgentsMdBlock(markdown)` is exported for testing. New `resolveManifest(argv, cwd)` returns `{ manifest, sourcePath }` — the parsed manifest plus the file that provided it; `loadManifest` and `manifestPath` are updated shims over it.

## 0.56.0 — 2026-06-23

- **`dispatch` gains the same opt-in antagonistic-review verify** (STDIO-458). `dispatch` / `dispatch_start` now accept `verify: true` (default false): after the agentic run, the worker's output is put through the shared adversarial-review verifier on the **reasoning** tier and, on a not-clean verdict, the agent is **re-run** with the review's blocking findings folded in — looped via the shared `runWithVerify` to a low cap (2), since each attempt is a full agentic pass. The returned text carries the verdict; the agent runs AND the reviewer (a different model) are metered as separate lines. An **agent** failure propagates as it does without verify; a **reviewer** failure, or an unconfigured reasoning tier, degrades to a legible note over the work rather than a crash (the two are told apart so an agent error is never mislabelled a review failure). The reasoning-tier reviewer is shared with `delegate` (`review.ts`, 0.55.0). **Limitation:** this reviews the agent's final OUTPUT text, not a read-back of the files it wrote — reviewing the written artefacts via the source adapter is the stronger follow-on gate (carded).

## 0.55.0 — 2026-06-23

- **`delegate` gains an opt-in antagonistic-review verify** (STDIO-458). `delegate` now accepts `verify: true` (default false): the worker's output is put through the shared adversarial-review verifier (`@verevoir/recipes/engine`, recipes 0.11.0) on the **reasoning** tier — a capable model, never the weak worker it judges — and the worker is looped on the review's blocking findings (the shared `runWithVerify`) until it passes or a small attempt cap is hit. The returned text carries the verdict (`reviewed on <model> (reasoning): approved after N attempt(s)`, or the unmet findings). Provider-agnostic: the reviewer is whatever `AIGENCY_MODEL_REASONING` resolves to (DeepSeek / Mistral / a local model), via the same OpenAI-compatible wire the worker uses. The worker AND reviewer (a different model) are metered as separate lines. Preserves `delegate`'s never-throw contract: an unreachable worker, an unconfigured reasoning tier, and a reviewer that errors mid-run each degrade to returning the work with a legible note rather than crashing. The OpenAI-compatible `usage` mapping is lifted into `openai-compat.ts`, shared by the worker call and the reviewer. (`dispatch` gets the same opt-in next.)

## 0.52.0 — 2026-06-19

- **Destructive-apply authorisation core — the `gate: destructive` enforcement** (STDIO-414, slice 1). `authoriseApply(plan, authorisedAddresses)` decides whether a Tofu apply may proceed given the plan's classification (STDIO-413) and the exact set of resource addresses a human explicitly acknowledged for destruction. An additive/in-place plan is always authorised (it runs under the normal assent gate). A **destructive** plan proceeds **only if the acknowledged set matches the plan's destructive set exactly**: every destroyed/replaced resource is acknowledged (no `unauthorised`) and the acknowledgement names nothing the plan no longer touches (no `stale`). Both mismatches refuse — **fail closed**: a blanket "yes" can't authorise a destructive apply, and a yes given against a _different_ plan (the plan drifted under the approval) can't either. This is the decision core the `tofu_apply` tool and the provision gitops workflow enforce separately (defence in depth), so the gate can't be the only thing between a stray plan and a dropped database. The gate-vocabulary in the corpus (`gate: none | assent | destructive`) and the `tofu_apply` wiring are the follow-on slices.

- **`update_card` / `create_card` can set assignees** (STDIO-408, MCP half). Both tools gain an optional `assigneeIds` (the board backend's user ids), threaded to the workflow adapter's `CardPatch` / `CardCreate` (the `@verevoir/workflows` adapters already implement it — Notion `people`, Trello `idMembers`, Obsidian no-op). `update_card` keeps the no-clobber rule: an omitted `assigneeIds` leaves existing assignees untouched. This is the **write side of the work-tracker ownership model** — e.g. assign a card to the operating user when it moves to In progress — which the periodic reconciler's ownership guard (verevoir/mcp 0.48.0, STDIO-407) reads to leave another user's in-progress cards alone. Tests drive both tools through their registered handlers with a faked adapter, asserting `assigneeIds` reaches the patch/fields and that omission doesn't clobber.

- **OpenTofu plan classifier — blast-radius before apply** (STDIO-413, slice 1). The first piece of the destruction-aware provisioning tools: a pure `classifyPlan` that parses a `tofu show -json` plan and classifies every resource change — `create` / `update` / `replace` / `destroy` / `read` / `no-op` — returning per-kind counts plus the **exact set of destructive addresses** (destroys + replaces) and a single `destructive` flag. `renderPlanSummary` **leads with the blast radius** (`⚠ DESTRUCTIVE — this plan DESTROYS 1 and REPLACES 1`, with the resource addresses) so a destructive plan shouts and an additive one reads clean. **Fail closed:** a plan it can't parse or a change it can't classify _throws_ rather than being read as "no destructive changes" — a malformed plan is never mistaken for a safe one. The destructive set is what a heavier, itemised `apply` authorisation must match (STDIO-414); the `tofu_plan` / `tofu_apply` tools and the provision gitops workflow build on this (STDIO-413/415).

- **Fork-isolated write-flow tools — `ensure_fork` / `ensure_branch` / `open_pull_request`** (STDIO-409). The shared layer already had the whole fork→branch→PR flow — `@verevoir/context`'s cached adapter exposes `ensureFork` / `ensureBranch` / `openPullRequest`, and the router resolves `forkOrg` — but the MCP exposed **none of it as tools**, only `write_file` / `edit_file`. So an agent couldn't fork, branch, or open a PR: a change to a repo it doesn't own had nowhere hermetic to land, and an explicit "fork it" was uncallable. These three thin tools close that, on a **source-vs-working** model: a repo is addressed by its **source URL** (its identity and the PR target); once forked, the fork is the **working URL** — the workspace you actually read, write, branch, and commit on. `ensure_fork(sourceUrl)` → `{ workingUrl }` (idempotent, forks into `forkOrg`); `ensure_branch(workingUrl, branch)` branches the fork; `open_pull_request(sourceUrl, workingUrl, branch, base, …)` builds the cross-repo head (`<fork-owner>:branch`) from the working URL for you and opens the PR against the source. The **source repo only ever receives a pull request, never a direct write**. For a repo you own, pass the same URL for both source and working (a same-repo PR, no fork). GitHub only (forks/PRs are a GitHub concept). First slice of the fork-isolation theme (STDIO-410 adds the `working-fork-established` capability; STDIO-411 thins aigency-web onto this).

## 0.48.0 — 2026-06-18

- **Periodic board reconciler — self-healing card sync** (STDIO-407, reconciler slice). The event-driven card-sync (STDIO-236) acts only on PR _open_ and _merge_, so a PR **closed without merging** strands its card (the drift we kept fixing by hand). A new scheduled `card-reconcile` workflow recomputes each card's **desired** column from live PR state across the org and fixes the drift — the controller / reconcile-toward-desired-state pattern. Desired column per work-item id: any **open** PR → "In preview"; else any **merged** → "Done"; else only **closed-unmerged** → "Not started"; no PRs → left untouched (no signal, so a human-placed card is safe). Precedence handles multi-PR ids (an open follow-up wins over an earlier merge; a merge wins over a superseded closed PR). **Ownership guard:** a card in **"In progress" assigned to another user** is that user's active work — the reconciler leaves it alone and logs why, unless `force`d; `RECONCILE_USER_ID` names the user the automation acts as so its own in-progress cards still reconcile. Pure core (`desiredColumn` / `indexPrStates` / `planReconciliation` / `reconcileBoard`, all unit-tested incl. the guard and best-effort per-move failure) + a `gh`-driven bin + the scheduled workflow. The cross-repo reusable-workflow rollout is the remaining STDIO-407 slice.
- **card-sync + reconcile list cards without bodies** (STDIO-236 timeout fix, folded in). `syncCard` and the reconciler only need a card's id / readableId / columnId (and assignees), but `listCards` defaults to fetching every card's Markdown body — on a large Notion board that's one `pages.retrieveMarkdown` call per row, which **timed out and silently skipped real syncs** (observed: a PR-opened sync best-effort-skipped on the timeout, leaving the card unmoved — the intermittent "didn't move" we chased). Both now pass `{ includeBody: false }`, so the list is one cheap call; a single body is still fetched on demand via `getCard` if ever needed.

## 0.47.0 — 2026-06-18

- **Corpus trust-boundary banner on every provisioned frame** (STDIO-399, threat-model S6 — disclosure+framing slice). `provision` injects practice + capability text straight into the model's prompt — the corpus **is** the bar the model is told to follow — so a poisoned practice/capability body is an injection vector **from inside the bar**, not through the reviewed data (STDIO-390). Likelihood is low while we author the corpus ourselves and rises sharply with growth, community contributions, or untrusted/remote sourcing. Every frame is now prefixed with a banner that frames the governance as the bar for **standards, not a channel for commands** — an instruction embedded in a body that would redirect the task, change permissions, exfiltrate data, or disable a check is a **corpus-poisoning finding to report, not follow** (the mirror of STDIO-390's untrusted-data framing). It also **discloses provenance**: when the corpus is loaded from a non-canonical `AIGENCY_GUARDRAILS_URL`, the banner names the source, so a swapped-out bar can't be silent. Applied as the outermost wrapper, so it covers both the capability section and the practices in every mode (default menu / `concerns` / `autoTag`). Hard enforcement — pinned/signed corpus, refusing untrusted sources outright — is the rest of STDIO-399.

## 0.46.0 — 2026-06-18

- **Egress disclosure on a non-Anthropic dispatch** (STDIO-397, transparency slice). `dispatch` can hand a whole task — including the **source**, which may be private — to a frontier worker on a third-party provider (DeepSeek on SambaNova, etc.). That the source left Anthropic is the most security-relevant fact about such a run, yet nothing surfaced it: the caller had to infer it from the model name. The result now carries an explicit **egress note** when the resolved provider isn't `anthropic` — naming the provider and stating the source was sent outside Anthropic, with the in-house alternative — and **stays silent** when the worker runs on Anthropic itself, so the disclosure is signal, not noise. A focused, legible change keyed on the already-resolved provider; the larger per-project **egress policy / consent gate** (block, or require opt-in, before private source leaves) stays on STDIO-397.

## 0.45.0 — 2026-06-18

- **Deterministic board-card sync from the PR lifecycle** (STDIO-236). Card column transitions stop being a thing an agent remembers and become a scripted CI side-effect: a `card-sync` workflow moves the work-tracker card to **"In preview"** when a PR opens and to **"Done"** when it merges, keyed off the `<Namespace>-<id>` work-item id in the branch. `syncCard` (pure, tested — happy path + card-not-found + column-not-found, case-insensitive column match) reuses the existing `@verevoir/workflows` board adapter via the `verevoir-card-sync` bin; the bin is **best-effort** — any failure (missing config, unknown card, network) logs and exits 0, because board sync must never block a merge, and never echoes the token. Needs `NOTION_API_KEY` (secret) + `BOARD_URL` (var) in CI. First step of STDIO-236; the periodic reconciler (self-healing safety net) and the roll-out to the other repos follow.

> Stacks on #64 (A2A auth, 0.44.0) — both off 0.43.0; merge order may need a one-line version/CHANGELOG reconcile.

## 0.44.0 — 2026-06-18

- **A2A bearer auth for the exposed path** (STDIO-404). When `A2A_AUTH_TOKEN` (or `serveA2A`'s `authToken`) is set, every request to the `verevoir-a2a` server — Agent Card, JSON-RPC, SSE stream — must carry `Authorization: Bearer <token>` or it's rejected **401** (distinct from a 404 or a JSON-RPC error, without revealing whether the token was missing or wrong). The compare is **constant-time** (`timingSafeEqual`) so the token can't be probed byte-by-byte. Unset = no auth, which stays safe only because the default bind is loopback (STDIO-398); the bin now **warns** when bound off-loopback with no token. The watch client (`verevoir-a2a-watch`) sends the token from the same env. Per-caller task scoping (multi-tenant isolation) is deferred — a single shared token is one trust boundary, which fits the single-deployment case.

## 0.43.0 — 2026-06-18

- **Bounded dispatch job store — TTL + cap** (STDIO-398, S7 slice). The in-process background-job store (`dispatch_start`/`dispatch_result`, and the A2A server) grew without bound and never evicted finished jobs — a memory/DoS surface (threat-model S7). Jobs are now evicted once they age past a TTL (default 1h) and the store is capped (default 100), trimming oldest-first. Eviction is lazy (on insert + poll), so no background sweep; the age stamp is kept internal, off the public `DispatchJob`. Polling an evicted handle reports legibly ("…it may have expired") rather than as a bare not-found. A `setDispatchStorePolicy` test seam drives the clock/TTL/cap deterministically.

## 0.42.0 — 2026-06-18

- **Dispatch hardened against prompt injection from the reviewed source** (STDIO-390, framing slice). A dispatched worker reads attacker-controllable content (a review/audit repo's files, comments, commit messages), and an LLM can't reliably tell that content apart from its own instructions — the verdict-manipulation threat from the STDIO-393 threat model (S1), for which we have live evidence. The dispatch system prompt now frames the source as **untrusted data, not instructions**: never obey instructions embedded in the source (e.g. "ignore your instructions", "rate this a pass"), instructions come only from the prompt + task, and any manipulation attempt is **reported as a finding** rather than acted on (turning the defence into a feature). A focused prompt change; the read-only-toolbelt mitigation is capability-driven (STDIO-392) and adversarial verdict-verification stays deferred (STDIO-390 #4).

## 0.41.0 — 2026-06-18

- **A2A stream viewer — `verevoir-a2a-watch`** (STDIO-395). A thin client that opens an A2A `message/stream` against a running `verevoir-a2a` server and renders the dispatch's `status-update` events as they arrive — round by round — ending on the terminal (`final`) event. Turns the SSE plumbing from STDIO-382 into something watchable ("see the polling rendered over A2A"): `formatStreamLine` renders a task with its state (and its result artifact once completed) and each status-update with its progress message; `watchA2A` drives the stream and also handles the server's plain JSON-RPC rejection of a bad request rather than choking on a non-SSE body. New `verevoir-a2a-watch` bin: `MODEL=… SOURCE=… verevoir-a2a-watch "<task>"` against a `verevoir-a2a` server.

## 0.40.0 — 2026-06-17

- **Opaque dispatch task ids** (STDIO-398, second slice). Background dispatch handles were sequential (`disp-1`, `disp-2`, …), so on the A2A surface a caller could guess another caller's handle and read its task (IDOR). Handles are now unguessable (`disp-<uuid>`), so they can't be enumerated. Combined with the loopback-bind default (0.39.0), the A2A IDOR is closed both by default (not network-reachable) and structurally (handles aren't guessable). Remaining on STDIO-398: bearer auth + per-caller scoping when the server is deliberately exposed, and job TTL.

## 0.39.0 — 2026-06-17

- **A2A server binds loopback by default** (STDIO-398, partial). The `verevoir-a2a` server (STDIO-382) is unauthenticated, but `node http` `listen(port)` binds all interfaces (`0.0.0.0`) — so as shipped it was network-reachable, letting anyone who could reach the port submit dispatch tasks on your worker credits and read other callers' tasks. It now binds `127.0.0.1` by default (`DEFAULT_A2A_HOST`); exposing it off-loopback is an explicit opt-in via the `host` option / `HOST` env, which logs a warning. This closes the network-exposure half of the threat (from the STDIO-393 threat model, S3); authentication and opaque/unguessable task ids remain on STDIO-398.

## 0.38.0 — 2026-06-17

- **Dispatch round-budget awareness** (STDIO-396, tier a). An agentic `dispatch` run could spend its whole `maxIterations` budget exploring (read/grep) and hit the cap before writing its answer — observed on a real review, which had to fall back to single-shot. The system prompt now states the round budget with the actual cap and instructs the agent to keep rounds in reserve to write, and to stop exploring and produce a complete answer as it approaches the limit. A cheap prompt-level nudge; the stronger dynamic per-round "rounds remaining" reminder (which needs `chatWithToolLoop` to inject a per-round message) is the llm-lib follow-on.

## 0.37.0 — 2026-06-17

- **Metering on `delegate` — closes the STDIO-385 follow-on** (STDIO-388). `delegate` now costs its one-shot worker call the same way `dispatch` does: it reads the `usage` field from the OpenAI-compatible chat response, warms the provider registry to price the worker's model from the catalog, and appends the `meterFooter` (`none` / `totals-only` / `verbose`), defaulting via `resolveMeterMode` / `AIGENCY_METER` with the same precedence as dispatch. The no-meter path stays cheap (no registry warm, no usage read). A worker that reports no `usage` gets a legible note — "the worker reported no token usage" — rather than a misleading $0 table, so "metered nothing" reads differently from "the worker didn't tell us". Both delegation paths are now instrumented.

## 0.36.0 — 2026-06-17

- **Config-default metering — `AIGENCY_METER`** (STDIO-387). Metering (STDIO-385) was a per-call `meter` param defaulting to `none`, so verbose cost reporting meant passing it every call. `dispatch` / `dispatch_start` now read an `AIGENCY_METER` env default when the param is omitted, so a deployment can turn metering on once in the MCP server env. Precedence: explicit per-call `meter` wins → else `AIGENCY_METER` (`none` / `totals-only` / `verbose`) → else `none`. An unrecognised value (explicit or env) falls through to `none` so a typo can't silently mean something unintended. (`delegate` is still unmetered — the STDIO-385 follow-on.)

## 0.35.0 — 2026-06-17

- **A2A (Agent2Agent) surface over the dispatch runtime — `verevoir-a2a`** (STDIO-382). `dispatch` already IS agent-to-agent delegation, and its async job lifecycle (`dispatch_start`/`dispatch_result`) already mirrors A2A's task lifecycle — so this puts that runtime behind Google's open **A2A** protocol: an **Agent Card** at `/.well-known/agent.json` (discovery), JSON-RPC **`message/send`** (submit a task) + **`tasks/get`** (poll), and **`message/stream`** (SSE progress). A thin, dependency-free adapter (`node:http` only): the execution backend stays the existing dispatch job store; this layer maps `DispatchJob` ↔ A2A `Task` (the dispatch handle becomes the opaque task id; the result becomes a text artifact; progress lines become status messages) and speaks the wire. The boundary validates every JSON-RPC request and reports legibly — a not-found task is A2A's `-32001`, distinct from a malformed request (`-32600`/`-32602`) or a parse error (`-32700`). It's a **separate, opt-in server** (`verevoir-a2a` bin / `npm run a2a`, `PORT=4100`) — the stdio MCP is untouched. This makes the card's "agents as standalone runtimes" trigger exercisable today: when a dispatched agent becomes a remote runtime, this is the seam dispatch speaks to, cross-vendor. Streaming + discovery come for free.

## 0.34.0 — 2026-06-17

- **Per-tier model slots — `AIGENCY_MODEL_REASONING` / `_DRAFTING` / `_EXTRACTION`** (STDIO-380). aigency's own model tiers map to the `@verevoir/llm` `ModelClass` ladder, and each can be named — by family or id — in its own env var. The named model resolves through the shared provider registry (`tiers.ts` → `modelConnection`, STDIO-378) to a usable OpenAI-compatible connection at use time, so config names a model by family and the concrete version binds when it runs. `delegate` now falls back to the **extraction** tier when no explicit or configured worker is set, resolving `AIGENCY_MODEL_EXTRACTION` by family to a real endpoint. The coordinator/Opus tier is the host's model, not set here. Registry-warming is extracted to a shared `registry.ts` (used by both `dispatch` and the tier slots), replacing `dispatch`'s private copy.

## 0.33.0 — 2026-06-17

- **Async / background dispatch — `dispatch_start` + `dispatch_result`** (STDIO-384). A synchronous tool call is bounded by the host's request timeout, so a long agentic run on a slow hosted model (DeepSeek-on-samba) times out. `dispatch_start` kicks the loop off **detached** and returns a handle immediately; `dispatch_result` **polls** it — `running` (with the progress so far) / `done` (the result text + trace + metering) / `failed`. The run pushes its progress into the job as it goes. This is the large/slow lane of the adaptive policy (sync `dispatch` stays the small/fast lane); same shape as A2A's task lifecycle (the in-MCP version). Background jobs are kept in an in-process store for the process lifetime.

## 0.32.0 — 2026-06-17

- **Metering on `dispatch` — none / totals-only / verbose** (STDIO-385). A `meter` param appends a token + cost table the same way aigency-web accounts, using `@verevoir/llm`'s per-call `TokenUsage` → `estimateCostUSD` over the catalog rate table: `totals-only` appends a total table (concrete model id + class, in/out tokens, USD price); `verbose` adds a line per tool round; `none` (default) appends nothing. The **concrete model id is what's metered/priced** — version matters here even though config names the family (STDIO-378). delegate metering is the follow-on (it needs the registry warm to price the worker's model).

## 0.31.0 — 2026-06-17

- **`dispatch` gains write tools, gh access, and live progress** (STDIO-383).
  1. **Read-write toolbelt** — `write_file` + `edit_file` let a frontier worker _change_ the source, not just review it (still no `delegate`/`dispatch` — no recursive delegation, and no card/board tools).
  2. **GitHub access via the `gh` CLI** — `resolveSourceEnv` falls back to `gh auth token` when `GITHUB_TOKEN` is unset, so the MCP can read whatever private repos the user's `gh` is logged into (an explicit `GITHUB_TOKEN` still wins). Fixes the 404 on private repos a scoped token can't reach, and lets `provision` read the guardrails corpus via broad gh auth.
  3. **Live progress** — `chatWithToolLoop`'s `onIteration` is wired to a stderr log **and** an MCP progress notification per round, so a slow run (each round is a full worker call) is observable instead of a silent wait.

## 0.30.0 — 2026-06-17

- **`dispatch` — run a frontier non-Claude model as an MCP agent** (STDIO-381). The complement to `delegate`: where `delegate` is the lower-model one-shot (text-in/text-out, no tools, bar pre-attached via `governed`), `dispatch` hands a whole task to a **frontier** worker (e.g. DeepSeek on SambaNova) and lets it **drive** — a read-only toolbelt (`read_file`, `grep`, `find_symbol`, `provision`) bound to `@verevoir/llm`'s `chatWithToolLoop`, so it explores the source, pulls its own practices via `provision`, reads real code, and produces the result, instead of judging a pre-chewed prompt. `model` is a family or id (`"deepseek"`), resolved via `resolveModelByTerm` (llm 0.15.0) to a provider + class; `source` is the repo/path. **Read-only by construction** — no write / edit / delegate / dispatch handed to a worker. Caps tool rounds (default 12). The third delegation mode alongside `delegate` (lower / one-shot) and the Claude Agent tool (Claude / with-tools).

## 0.29.0 — 2026-06-17

- **`delegate` advertises the worker's models + resolves loose names** (STDIO-379). The `delegate` description now lists the models the configured worker actually serves — queried live via the worker's OpenAI-compatible `GET /models` at registration (cached, short timeout) — so a coordinator told _"use deepseek to review this"_ sees `DeepSeek-V3.2` in the list and can pass it. And the per-call `model` is now **resolved against that served set**, so a model can be addressed **loosely (`deepseek`) or exactly (`DeepSeek-V3.2`)**: an exact match passes straight through, a loose one picks the newest served match (`deepseek` → `DeepSeek-V3.2` over `V3.1`). No effect when the worker serves nothing reachable — the request passes through unchanged.

## 0.28.0 — 2026-06-17

- **Ship the provider SDKs + advertise providers dynamically** (STDIO-377). The MCP declared six reasoning providers (STDIO-347) but shipped only `@anthropic-ai/sdk`, so `import('@verevoir/llm/<p>')` threw for deepseek/openai/samba/mistral ("Cannot find package 'openai'") and google ("@google/genai") — **five of six reasoning providers were dead on the published host** (why a coordinator "couldn't find deepseek"). Add `openai` (covers openai/deepseek/samba/mistral) + `@google/genai` (google) as dependencies so every provider loads. And make two tool descriptions **dynamic**, read at registration so they reflect the actual deployment: `provision` lists the supported reasoning providers and which are configured here (`reasoningProvidersSummary`); `delegate` reports the configured worker (model + endpoint) or that none is set, noting the worker is any OpenAI-compatible endpoint with a local Ollama default (`workerSummary`). So a coordinator discovers what's available instead of guessing.

## 0.27.0 — 2026-06-17

- **Adopt `@verevoir/llm` 0.14.0** (STDIO-376) — `^0.13.0 → ^0.14.0`. The reasoning provider (`provisionFrame` autoTag) imports `@verevoir/llm/<provider>` and calls `chat()`, and those adapters now honour per-provider **base-URL overrides** (`<PROVIDER>_BASE_URL`) plus keyless-local (openai). So setting e.g. `SAMBA_NOVA_BASE_URL` / `ANTHROPIC_BASE_URL` on the MCP host points its reasoning calls at a gateway / proxy / regional / self-hosted endpoint with **no MCP code change**. The cross-provider routing surface (`resolveModel` / `isProviderConfigured`) is now available to wire into reasoning-provider selection (follow-on). No behaviour change without the new envs set.

## 0.26.0 — 2026-06-17

- **`provision` selects by the coordinator, not a reasoning call** (STDIO-348). The dedicated concern-tagging LLM call (and its `ANTHROPIC_API_KEY`) is no longer the default path — it was the most expensive _and_ lowest-recall way to select practices (it only ever saw a prose blurb, and demonstrably missed literal matches, e.g. `health-endpoint-is-standard` on "wire a health endpoint"). The floor still always comes back in full with no model call; concern practices are now chosen by whoever has the context:
  - **default (catalogue)** — `provision({ prose? })` returns the floor plus a **menu** of the concern practices (id + their one-line `Protects:` blurb). A capable coordinator sees the whole task, narrows the menu, and calls back with `concerns: [...]`. No key, no reasoning call, better selection.
  - **`provision({ concerns: [...] })`** — the floor plus exactly those concern bodies: a complete, injectable frame.
  - **`provision({ prose, autoTag: true })`** — select concern practices in-MCP via the reasoning provider (needs its key), for a weak/headless caller with no coordinator to narrow. The **only** path that still needs a key; STDIO-348 v2 (embeddings facet-narrow) aims to retire even it.
  - **`delegate`** routes its worker through `autoTag` — a worker can't narrow a menu, so it gets full bodies selected in-MCP, as before.
  - The bare-string form (`provisionFrame('…')`) still works, as the default catalogue. Validated by re-running cpu8 across the worker-model matrix (STDIO-368).

## 0.25.0 — 2026-06-15

- **`provision` drives the shared capability matcher** (STDIO-328). The advisory capability surfacing in `provisionFrame` no longer hand-rolls its own index-build + cosine + `{ type, summary }` mapping — that logic now lives once in `@verevoir/recipes` (`retrieveCapabilities`), and the MCP supplies only the host-specific bits (its fetch embedder, its corpus loader). `SurfacedCapability` is re-exported from recipes so the MCP and the website surface matches in **exactly the same shape**, rather than each keeping a copy that can drift. No behaviour change. (`@verevoir/recipes` `^0.5.0 → ^0.6.0`.)

## 0.24.0 — 2026-06-15

- **Practice concern-tagging is no longer Anthropic-pinned** (STDIO-347). `provisionFrame`'s reasoning call — which tags a task's applicable concerns — now runs on the **configured reasoning provider** instead of always Anthropic. `AIGENCY_REASONING_PROVIDER` selects one of `anthropic` / `google` / `openai` / `deepseek` / `samba` / `mistral` (default `anthropic`, so **no behaviour change**), gating on that provider's own key env and lazily importing its `@verevoir/llm` chat. Concern-tagging still degrades to the foundational floor on any failure. This matters more now that governed `delegate` (0.23.0) provisions on every call. Interim mcp-local convention — aligns with STDIO-332's account-level routing when that lands; the env is the seam. (STDIO-348 will go further: drop the reasoning call and select practices by a prose parse shared with capability retrieval.)

## 0.23.0 — 2026-06-15

- **`delegate` is governed by default** (STDIO-346). A delegated worker won't fetch the bar itself, so the practices **and** capabilities its work is held to now travel with the task automatically: with the MCP loaded you've opted into governance, so `delegate` provisions the task (`provisionFrame`) and prepends the resulting frame to the worker's prompt. The frame is **resolved afresh from each worker's own prompt** — the bar must fit the task in hand, not one further up a delegation chain, so there's nothing to pass on or reuse. `governed: false` is the explicit escape for genuinely throwaway work. The worker-config check runs first, so an unconfigured worker never triggers a wasted provision; `provisionFrame` never throws (it degrades to the foundational floor), so governance can't block a call. Found via the cpu8 stress-test: practices were **pull-only** and workers almost never pulled, so delegated builds ran with none of the bar.

## 0.22.1 — 2026-06-13

- **Dependency-currency sweep** (STDIO-334): `@verevoir/recipes` `^0.3.2 → ^0.5.0`, `@verevoir/context` `^0.11.1 → ^0.11.2`, `@verevoir/workflows` `^0.5.0 → ^0.5.1`. Added a direct `@verevoir/llm` `^0.13.0` dependency: recipes `0.5.0` moved `@verevoir/llm` to an (optional) **peer** dependency (STDIO-343), but `recipes/engine` still statically imports `@verevoir/llm/anthropic` as the default reasoning client, so a consumer that uses provisioning must provide it. mcp's `provision` tool calls `provisionPractices` on the default client, so llm is now declared directly rather than relied on transitively. No behaviour change; `npm audit` clean.

## 0.22.0 — 2026-06-13

- **`write_file` / `edit_file`: `branch` + `commitMessage` are now optional** (STDIO-302). They're only used for GitHub commits — filesystem and Notion writes ignore them — so requiring them on every call was a smell (required-but-ignored). They're now optional in the schema; a **GitHub** source still gets a clear error if either is missing, and filesystem / Notion callers simply omit them. No behaviour change for GitHub callers that already passed both.
- **`find_symbol` / `code_graph` now work with a `file://` URL** (STDIO-317). A `file://` source warmed the cache under one key and was queried under another, so it returned **0 hits** (a bare absolute path worked). Both handlers now normalise `file://` to the bare path before warming + querying, so the two halves share one key. Verified end-to-end: `file://` and the bare path return identical results.

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
