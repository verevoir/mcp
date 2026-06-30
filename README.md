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

#### Pointing the server at a project

The server injects an operating doctrine into the model's context on connect. When it finds a project pointer manifest, it appends a project-specific section naming _this_ project's work tracker, project record, and ADR database as concrete Notion URLs.

**Add a `verevoir-mcp` block to your project's `AGENTS.md`.** This is the way to point the server at project documentation and task trackers. `AGENTS.md` is already the per-repo agent context file the `agent-context-file-maintained` practice requires — putting the manifest there keeps the pointer with the rest of the project context, with no separate file to drift.

The server reads `AGENTS.md` from its working directory at startup. Add a fenced code block whose info-string is `verevoir-mcp` anywhere in the file; the block body is parsed as the manifest JSON:

````markdown
## Project context

This repo is part of the acme project. Work tracker, decisions, and project
record are in Notion — the verevoir MCP reads from there.

```verevoir-mcp
{
  "notion": {
    "workspaceRootPageId": "11112222-3333-4444-5555-666677778888",
    "databases": {
      "work_tracker": "aaaa1111-2222-3333-4444-555566667777",
      "adrs":         "bbbb1111-2222-3333-4444-555566667777"
    }
  },
  "governance": [
    { "source": "../guardrails", "paths": ["corpus/practices"] }
  ]
}
```
````

**Resolution precedence.** The server tries each source in order; the first that yields a valid manifest wins:

1. `--manifest <path>` — explicit flag, always wins. Accepts a JSON file or a Markdown file containing the `verevoir-mcp` block. Supply it after the script path: `"args": ["/path/to/mcp/dist/bin.js", "--manifest", "/path/to/project/AGENTS.md"]`. Throws on a missing/bad flag value — a botched arg fails loudly rather than silently dropping to no-project mode.
2. `AGENTS.md` in the working directory — if it contains a `verevoir-mcp` fenced block with valid JSON (the recommended path above).
3. `verevoir-mcp.json` in the working directory — accepted fallback; no dedicated setup example here.
4. `aigency.json` in the working directory — legacy fallback; accepted long-term but not the recommended approach.
5. None found → **no-project mode**: the server still starts and serves the universal doctrine; only the project-specific section is omitted.

A present-but-malformed source at any step (bad JSON, missing block) is skipped gracefully and resolution continues to the next candidate.

#### Why `"alwaysLoad": true`

Without this flag, Claude Code auto-defers MCP tool schemas when total tool definitions exceed ~10% of the context window — only tool _names_ are sent up front; the model must call `ToolSearch` to load each schema before using it. That extra step makes the verevoir tools lose against always-on shell reflex (`grep`, `cat`, `find`) at the moment of choosing a tool — defeating the cache + freshness benefits of the MCP layer. `alwaysLoad: true` (Claude Code v2.1.121+) forces every tool from this server into the session at startup, so `read_file` / `grep` / `find_symbol` / `list_cards` are reflex-reachable. Older Claude Code versions ignore the flag (no breakage). The cost is ~2–5KB of context — worth it.

Env vars are read per-tool: GitHub tools only need `GITHUB_TOKEN`; Trello tools only need the three `TRELLO_*` vars; Notion tools (both source and workflow) only need `NOTION_API_KEY`. The server starts regardless of which are set — missing-env errors surface at tool-call time with clear messages naming the variable.

## Using with other MCP clients

`@verevoir/mcp` is a stdio server and works with any MCP client. See [docs/clients.md](docs/clients.md) for per-client config snippets covering Warp, Cursor, Gemini CLI, OpenAI Codex CLI, opencode, Cline, Continue, and Zed.

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

| Tool                | Args                                                     | Returns                |
| ------------------- | -------------------------------------------------------- | ---------------------- |
| `read_file`         | `{ sourceUrl, path, ref? }`                              | `{ content, sha }`     |
| `list_files`        | `{ sourceUrl, prefix?, ref? }`                           | `DirEntry[]`           |
| `get_repo_tree`     | `{ sourceUrl, ref? }`                                    | `RepoTree`             |
| `grep`              | `{ sourceUrl, pattern, ref?, ignoreCase?, maxResults? }` | `GrepHit[]`            |
| `find_symbol`       | `{ sourceUrl, name, ref?, kind? }`                       | `SymbolHit[]`          |
| `write_file`        | `{ sourceUrl, path, content, branch, commitMessage }`    | `{ ok: true }`         |
| `edit_file`         | `{ sourceUrl, path, oldString, newString, branch?, … }`  | `{ ok, replacements }` |
| `ensure_fork`       | `{ sourceUrl }`                                          | `{ workingUrl }`       |
| `ensure_branch`     | `{ workingUrl, branch }`                                 | `{ ok, branch }`       |
| `open_pull_request` | `{ sourceUrl, workingUrl, branch, base, title, body }`   | `{ prUrl }`            |

`grep` and `find_symbol` operate on **cached** content only — call `read_file` first on any files you want searchable. The cache is per-process, lazy-population.

**Fork-isolated write flow (GitHub).** A repo is addressed by its **source URL** — its identity and the PR target. Once forked, the fork is the **working URL**: the workspace you actually read, write, branch, and commit on. The source repo is never written directly; it only ever receives a pull request from the fork — so an agent can change a repo it does **not** own _hermetically_. The shape:

1. `ensure_fork(sourceUrl)` → `{ workingUrl }` — forks into the configured fork org, idempotent.
2. `ensure_branch(workingUrl, branch)` — branch on the fork.
3. `write_file` / `edit_file` against the **workingUrl** — the change lands on the fork.
4. `open_pull_request(sourceUrl, workingUrl, branch, base, …)` — the cross-repo head (`<fork-owner>:branch`) is built from the working URL for you; the PR is opened against the source.

For a repo you own, pass the same URL for both `sourceUrl` and `workingUrl` (a same-repo PR, no fork).

### Workflow tools (kanban / issue / objective sources)

All take a `boardUrl`:

- `https://trello.com/b/<id>` → Trello adapter.
- `https://www.notion.so/<workspace>/<db-id>?v=...` (or any notion.so URL form pointing at a database) → Notion adapter. Rows become `Card`s; auto-detects which property is the status / column from the database schema.
- Absolute filesystem path or `file://` URL ending in `.md` → Obsidian Kanban adapter. Local board `.md`; `## headings` are columns; `- [ ] [[Note]]` wikilinks are cards; the linked note is the card source of truth; no credentials required.
- Absolute filesystem path or `file://` URL to a **directory** (the project root or its `backlog/` dir) → Backlog.md adapter. `backlog/config.yml` statuses are columns; `backlog/tasks/*.md` are cards (frontmatter `id` / `title` / `status` / `labels` / `assignee` / `parent_task_id`, markdown body as the description); for tracking work as committable files inside a code repo; no credentials required.

| Tool            | Args                                                                                | Returns        |
| --------------- | ----------------------------------------------------------------------------------- | -------------- |
| `list_columns`  | `{ boardUrl }`                                                                      | `Column[]`     |
| `list_cards`    | `{ boardUrl, columnId?, assigneeId?, labelId?, parentId? }`                         | `Card[]`       |
| `get_card`      | `{ boardUrl, cardId }`                                                              | `Card`         |
| `create_card`   | `{ boardUrl, columnId, title, body?, labelIds?, assigneeIds?, dueDate? }`           | `Card`         |
| `update_card`   | `{ boardUrl, cardId, title?, body?, columnId?, labelIds?, assigneeIds?, dueDate? }` | `{ ok: true }` |
| `move_card`     | `{ boardUrl, cardId, toColumnId }`                                                  | `{ ok: true }` |
| `list_comments` | `{ boardUrl, cardId }`                                                              | `Comment[]`    |
| `add_comment`   | `{ boardUrl, cardId, body }`                                                        | `{ ok: true }` |

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

### Worker tools (delegate / dispatch)

`delegate` hands a self-contained sub-task to this project's configured **worker model** and returns its result — for offloading bounded work from the coordinator to a cheaper worker. The worker runs on the **extraction tier** (env: `AIGENCY_MODEL_EXTRACTION` model name or family; `AIGENCY_MODEL_EXTRACTION_URI` for a direct OpenAI-compatible endpoint; `AIGENCY_MODEL_EXTRACTION_KEY` API key). With no extraction tier configured the tool returns a short notice rather than erroring. Three tiers are available across the worker tools: **reasoning** (`AIGENCY_MODEL_REASONING_*`, default opus), **drafting** (`AIGENCY_MODEL_DRAFTING_*`, default sonnet), **extraction** (`AIGENCY_MODEL_EXTRACTION_*`, default haiku). Legacy `AIGENCY_WORKER_URL` / `AIGENCY_WORKER_MODEL` / `AIGENCY_WORKER_API_KEY` vars are accepted as aliases for the extraction tier. `dispatch` goes further: it hands a **frontier** model a read/write toolbelt it drives itself over a source (vs delegate's one-shot, no-tools call), with `dispatch_start` / `dispatch_result` for long runs that would exceed a synchronous timeout. Both take an optional `meter` (`none` | `totals-only` | `verbose`, or the `AIGENCY_METER` env default) that appends a token + cost + time footer (STDIO-436) — per-model tokens, in/out direction, cache read/write tokens (priced separately so a cache hit reads as a saving), wall-clock time, and total USD; `verbose` adds a line per round.

### Loop tools (refine / search)

"Ralph looping" over the worker model: keep producing an attempt, **score** it, and feed the score's feedback into the next attempt — so the work _improves_ across iterations instead of re-rolling. `refine` runs one improving line; `search` runs K diverse seeds, each its own refine loop (its **arms in parallel**), and selects the global best — escaping a local optimum a single line gets stuck in. Both are slow (many worker calls), so both are **background jobs**: `refine_start` / `search_start` return an unguessable handle immediately, `refine_result` / `search_result` poll it.

Each attempt is scored by an **eval** (`eval.kind`, normalised to 0..1):

- `deterministic` — a JS expression scoring the string `output` to a number, **no model** (the cheap path), e.g. `expression: "output.length <= 400 ? 1 : 0"`.
- `judge` — the worker scores against a `rubric` (judge on a specific model with `judgeModel`).
- `practices` — provision the **bar** for `workDescription` and score against it: _loop until the work meets the standards the rest of the MCP holds work to_.

The **stop policy** ends the loop as soon as **any** condition is met: `maxLoops` (the always-set backstop), `targetScore` (stop at or above it), or `diminishingReturns: { epsilon, window }` (stop once the best score's improvement over the last `window` iterations falls below `epsilon`).

```ts
// Refine against a rubric, stopping when it plateaus rather than at a fixed count.
refine_start({
  task: 'Draft a migration runbook for splitting the orders table.',
  eval: {
    kind: 'judge',
    rubric: 'Complete, ordered, reversible steps; calls out the lock window; names rollback.',
  },
  stop: { maxLoops: 6, diminishingReturns: { epsilon: 0.05, window: 3 } },
});

// Loop N times on a specific worker model ("loop this 6 times with mistral");
// the judge can run on a different model.
refine_start({
  task: 'Refactor this function for readability: …',
  model: 'mistral',
  eval: { kind: 'judge', rubric: 'clearer naming, no behaviour change', judgeModel: 'deepseek' },
  stop: { maxLoops: 6 },
});

// Multi-seed search — K diverse approaches in parallel, select the best.
search_start({
  task: 'Name this open-source project: a fast Terraform linter.',
  seeds: ['evoke speed', 'evoke safety and correctness', 'a playful, unexpected angle'],
  eval: { kind: 'judge', rubric: 'memorable, sounds available, hints at the domain' },
  stop: { maxLoops: 3, targetScore: 0.9 },
  concurrency: 3,
});
```

Both results carry the full **trace** — every iteration's score and feedback, the winning output, and why it stopped (and, for search, every seed's best, not just the winner's) — so a run is auditable rather than opaque. Give `search` explicit `seeds` or a `seedCount` of generated diverse starts.

Pass **`meter`** (`totals-only` | `verbose`) to append a token + cost + time footer for the worker **step** calls — the attempt-maker `model` selects (summed across all seeds for `search`): wall-clock time, per-model tokens, in/out direction, cache read/write, and total USD.

**Driving it from a prompt.** These are ambient tools — you don't hand-write the JSON above. Describe the task and the bar to the coordinator in plain language and it fills in `refine_start` / `search_start`, then polls `*_result` and relays the best attempt. The `task` you give **is** the worker's prompt; the `rubric` (or `workDescription`) is how you state the bar in words — so "loop a prompt with an eval" is just a sentence:

| You say                                                                                                  | The coordinator runs                                                                                                                                          |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Refine a tagline for Acme until it's punchy and under 60 chars — stop when it's good or after 5 tries." | `refine_start({ task: 'Write a tagline for Acme', eval: { kind: 'judge', rubric: 'punchy; under 60 characters' }, stop: { maxLoops: 5, targetScore: 0.9 } })` |
| "Loop this refactor 6 times with mistral, judged by deepseek."                                           | `refine_start({ task: 'Refactor: …', model: 'mistral', eval: { kind: 'judge', rubric: '…', judgeModel: 'deepseek' }, stop: { maxLoops: 6 } })`                |
| "Try four angles on the name and show me the best."                                                      | `search_start({ task: 'Name …', seedCount: 4, eval: { … }, stop: { … } })`                                                                                    |
| "Keep working this until it meets our practices."                                                        | `eval: { kind: 'practices', workDescription: '…' }`                                                                                                           |

Because runs are background jobs, the coordinator holds the handle and polls until done — you just see the result and its trace. (Distinct from the MCP **prompts** above: those are host-executed skill _templates_; the loops are _tools_ you steer in natural language.)

## Audit log

Every tool call in `delegate`, `dispatch`, and the loop tools (`refine` / `search`) can write a structured trace to a per-session JSONL file. The trace is OpenTelemetry-shaped — you can replay a session as an interactive flame chart in under 30 seconds.

### Configuring the audit log

Set `AIGENCY_AUDIT` in the MCP server's env:

| Value           | Effect                                                                      |
| --------------- | --------------------------------------------------------------------------- |
| `off` (default) | No files written.                                                           |
| `on`            | Timing + identity fields only — no tokens or costs.                         |
| `verbose`       | Same as `on`, plus token counts, cost, and cost rollup on capability spans. |

Additional env vars:

| Env var                     | Default            | Meaning                                                     |
| --------------------------- | ------------------ | ----------------------------------------------------------- |
| `AIGENCY_AUDIT_DIR`         | `./aigency-audit/` | Directory for session files (created on first write).       |
| `AIGENCY_AUDIT_SESSION_GAP` | `120`              | Seconds of inactivity before a new session file is started. |

A **session** is a burst of activity. The first span after a `AIGENCY_AUDIT_SESSION_GAP`-second silence starts a fresh file named by the session-start ISO timestamp (e.g. `aigency-audit/2026-06-27T10-05-00.000Z.jsonl`). This keeps one noisy afternoon's work separate from the next morning's run.

The per-call `meter` param on `delegate` / `dispatch` / `refine_start` / `search_start` is a separate, unrelated feature — it appends an inline cost-in-result footer to that single call's result text. The audit log is session-wide and file-backed; `meter` is per-call and text-only. Both can be active at the same time.

### Reading the audit log — view as a flame chart

**The headline view: convert a session to Chrome Trace and open it in speedscope.app:**

```bash
verevoir-audit-trace aigency-audit/2026-06-27T10-05-00.000Z.jsonl > trace.json
# then open trace.json at https://speedscope.app — drag and drop
```

The converter (`verevoir-audit-trace`) is the bin installed alongside the package. By default it emits **Chrome Trace Event JSON** (`{ traceEvents: [...] }`), which any of these viewers accept:

- **speedscope.app** — drag the JSON file in; the "Timeline" view shows the cascade as a flame chart.
- **Perfetto UI** (ui.perfetto.dev) — open via File → Open trace file.
- **chrome://tracing** — load the file from the load button.

Pass `--otlp` to emit OTLP-JSON instead (for Jaeger / Tempo / any OpenTelemetry collector). Use `-o <file>` to write to a file rather than stdout.

**Span entry schema** (one JSON object per line in the `.jsonl`):

```ts
{
  trace_id: string;        // UUID shared by all spans in one session trace
  span_id: string;         // UUID unique to this span
  parent_span_id?: string; // UUID of the parent span (absent for root spans)
  name: string;            // e.g. "tool:delegate", "delegate", "delegate:model:DeepSeek-V3.2"
  kind: "capability" | "tool" | "model";
  start: string;           // ISO 8601 timestamp
  end: string;             // ISO 8601 timestamp
  duration_ms: number;
  // only in verbose mode:
  attributes?: {
    model?: string;        // model name (model spans)
    tokens_in?: number;
    tokens_out?: number;
    cached?: number;       // cached input tokens (model spans)
    cost?: number;         // USD cost of this model call (model spans)
    cost_rollup?: number;  // total USD across all model spans in the capability (capability spans)
  };
}
```

**How to reconstruct the cascade.** Spans in a single session share a `trace_id`. A span whose `parent_span_id` matches another span's `span_id` is its child. The typical shape is: a `tool` span (the MCP handler) → a `capability` span (the full `delegate` / `dispatch` run) → one or more `model` spans (each LLM call). The converter builds the flame chart from this nesting automatically.

### Live OTLP export — one collector for a whole session (incl. Claude Code)

The `verevoir-audit-trace` bin above is the **post-hoc** path (a finished JSONL → a file). For a **live** trace — and to unify the MCP's spans with **Claude Code's own** turns, tools, and token usage in a single view — set the standard OpenTelemetry endpoint and each span is **also** POSTed to the collector as it finishes, alongside the local JSONL:

| Variable                      | Effect                                                                                                      |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | When set (and `AIGENCY_AUDIT` ≠ `off`), POST each span to `<endpoint>/v1/traces`. Unset → local JSONL only. |

Because it's the **standard** OTel env, the same endpoint unifies every source: the MCP, **Claude Code** (`CLAUDE_CODE_ENABLE_TELEMETRY=1` + the same `OTEL_EXPORTER_OTLP_ENDPOINT`), and the aigency executor all land in one trace. The export is **fire-and-forget and fail-soft** — a slow or unreachable collector never blocks a tool or changes a result.

**Audit a session, then throw the collector away** — no standing infrastructure:

```bash
# 1. a throwaway collector that streams everything to one file
cat > /tmp/otelcol.yaml <<'YAML'
receivers: { otlp: { protocols: { http: { endpoint: 0.0.0.0:4318 } } } }
exporters: { file: { path: /trace/session.json } }
service: { pipelines: { traces: { receivers: [otlp], exporters: [file] } } }
YAML
docker run --rm -d --name otelcol -p 4318:4318 \
  -v /tmp/otelcol.yaml:/etc/otelcol/config.yaml -v /tmp:/trace \
  otel/opentelemetry-collector:latest

# 2. point the session at it and run
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
export AIGENCY_AUDIT=verbose
export CLAUDE_CODE_ENABLE_TELEMETRY=1   # Claude Code's own turns/tools/tokens too

#    … run your session …

# 3. tear down — the unified trace is in /tmp/session.json (OTLP JSON)
docker rm -f otelcol
```

The MCP's file `--otlp` output and this live stream share one mapping (`src/otlp.ts`), so the two are byte-identical in shape.

## Board card sync (CI)

The `card-sync` workflow moves a PR's work-tracker card through the board from the PR lifecycle — **opened → "In preview"**, **merged → "Done"** — keyed off the `<Namespace>-<id>` work-item id in the branch (STDIO-236). Deterministic and best-effort: an unknown card or missing config is logged and **never blocks the merge**.

To activate it, set two values **at the GitHub org level** (once, not per-repo — the credential should have one holder):

- **`NOTION_API_KEY`** — an org **secret**: the board's Notion integration token.
- **`BOARD_URL`** — an org **variable**: the board's Notion database URL, e.g. `https://www.notion.so/<database-id>`.

Until both are set the workflow step best-effort-skips (no token → exit 0), so it is inert and harmless.

### Periodic reconciler (self-healing)

Events can be missed — a webhook drops, or a PR is **closed without merging** and strands its card. The `card-reconcile` workflow (STDIO-407) runs on a schedule (and on demand via `workflow_dispatch`): it recomputes each card's **desired** column from live PR state across the org and fixes any drift — the controller / reconcile-toward-desired-state pattern. The desired column for a work-item id is: any **open** PR → "In preview"; else any **merged** PR → "Done"; else only **closed-unmerged** PRs → "Not started". A card with no PRs is left where a human put it.

- **Ownership guard.** A card sitting in **"In progress" assigned to another user** is that user's active work — the reconciler leaves it alone and logs why, rather than yanking it on PR-derived state. Set **`RECONCILE_USER_ID`** (the board user the automation acts as) so cards assigned to that user are still reconciled; cards assigned to anyone else in progress are skipped. With no `RECONCILE_USER_ID` set, any assigned in-progress card is treated as another's and left alone.
- Same best-effort contract: a board hiccup logs and exits 0, never failing the job. Uses the same org `NOTION_API_KEY` + `BOARD_URL`, plus the CI `GITHUB_TOKEN` for the PR search.

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
