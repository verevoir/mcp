# Working with this project via Verevoir

Verevoir is the front door for reading and writing files, code, and project context. These tools share a cache + tree-sitter index across the whole session; your built-in filesystem/shell tools do not — so reaching for them in preference is not a style nicety, it keeps that shared view correct.

- **Writes — always through the MCP.** Make every change to a covered `sourceUrl` / `boardUrl` with `write_file` / `edit_file` (or the card tools). A write that goes around them — shell redirection, `sed -i`, or the built-in Edit/Write on a covered path — leaves the shared cache stale and _wrong_ for the rest of the session, so later reads and searches serve pre-write content. This is the firm rule: never edit a covered file out-of-band.
- **Reads — prefer the MCP.** Use `read_file` / `grep` / `find_symbol` over the built-in Read / `cat` / shell `grep` / `find` / `ls`. A bypassed read is less costly than a bypassed write — it only misses the cache + index benefit (slower, duplicate fetches, no Notion) rather than corrupting state — but the MCP is still the default whenever a `sourceUrl` fits.

## Before you change code, consult the bar

Before you implement, write, or change code, call **`provision`** with a short description of the work. Treat this as a precondition for the change, the same way writing through the MCP is: skip it and your code is judged against standards you never read.

It returns, in one call as text, the **foundational floor practices in full** plus a **menu of the concern practices** (each a one-line summary). You see the whole task, so you narrow better than any isolated classifier: **pick the concerns that apply and call `provision` again with `concerns: ['id', …]`** to pull their full text alongside the floor — a complete frame you can also hand to a worker. (`find_governance` is still there for browsing the wider record; `provision` is the triggered shortcut for "what am I held to for _this_.")

If you hand the work to another model, the bar must travel with it — a floor worker won't fetch it itself. The **`delegate`** tool does this for you by default (it provisions the worker's task and carries the frame into its prompt); for a sub-agent you spawn another way, pass a provisioned frame in its prompt yourself. A weak/headless caller with no coordinator to narrow can pass `autoTag: true` to have `provision` select the concerns in-MCP instead of returning a menu.

## Handing off work — delegate down, and the bar goes with it

When a piece of work is **mechanical or bulk** — scaffolding, boilerplate, repetitive file-writing, a wide read-and-summarise — hand it to **`delegate`** (a bounded sub-task) or **`dispatch`** (a whole task a worker drives agentically) rather than doing it inline or spawning a same-tier sub-agent of your own. Two things happen by default that don't happen otherwise:

- **It runs on a cheaper tier.** `delegate` / `dispatch` route to the configured worker, so the bulk of the tokens leave the expensive coordinator. A sub-agent you spawn another way inherits _your_ tier — so parallelising it makes the work faster but not cheaper, and often dearer (more coordination at the top tier).
- **The bar travels with it.** Governed by default, `delegate` provisions the work's own practices and carries them into the worker's prompt, so a cheaper model is held to the same standard. A worker handed the task _without_ the bar does competent work to the _wrong_ standard — the cheaper tier is only safe _because_ the bar is attached.

When the work is something a **capability** covers — converting a design system to tokens, scaffolding a service, a discovery pass — reach for **`enact_capability`** rather than assembling the handoff yourself. You name the capability and a directive; it loads what a good output looks like, provisions the bar, produces on the worker tier, and verifies the result against that bar on the reasoning tier — looping until it passes. It is the single door for capability-shaped work: the tiering and the verify are applied structurally, so you don't have to remember to delegate, attach the bar, and review by hand each time.

Rule of thumb: **the reasoning, and the decision of what to hand off, stay with you; the doing goes to `enact_capability` (capability-shaped work) or `delegate` / `dispatch` (free-form bulk), which pick the tier and carry the standard.** Keep inline work for the small, judgement-heavy pieces.

## One surface, auto-routed by URL

The same tools work uniformly across:

- **Local repos / files** — absolute path or `file://` (e.g. `/Users/you/project`)
- **Git hosts** — `https://github.com/owner/repo` (more adapters land over time)
- **Notion** — `https://www.notion.so/<id>` (pages read as a file tree; databases act as work-tracker boards)

Reads are cached and tree-sitter symbol-indexed via `@verevoir/context` and shared across the whole session, so reading a file also warms it for later search. Native reads bypass that cache and its freshness tracking — and can't see Notion at all.

## File workflow

`get_repo_tree` or `list_files` to orient → `read_file` to pull a specific file (this warms the cache) → `grep` / `find_symbol` to search. `grep` and `find_symbol` scan the whole source on demand and warm the cache as they go, so they need no prior `read_file` — reach for them directly when you're searching rather than opening one file you already know.

## Project state lives in the tools, not the local git tree

- **The board is the project's current state.** Asked what's going on — the state, what's in progress, what's next, what's left — read the work tracker first (`list_columns` / `list_cards`). The local git tree and open PRs are the operational shell, **not** the project's state: a clean working tree does not mean there is no work in flight.
- **The board is also where work goes.** Anything work-shaped — a to-do, a gap, a bug, a deferred decision — is a card (`create_card` / `update_card` / `move_card`), not a note kept off to the side.
- **Project record** — ADRs, intent, and other durable context live in Notion; reach them via the Notion source tools, not by grepping local files.

## Fix the source, not the leaf

When something is wrong, or a change needs to land in many places, ask whether you are patching an _artefact_ or its _generator_. Prefer the upstream fix — the template, the prompt, the tool that emits the thing — over editing each downstream copy by hand.

## Working discipline

- **Trace work to the tracker.** When you act on a tracked item, carry its id through the branch, commit, and PR title (e.g. `<id>: <subject>`) so the change links back to the board.
- **One change, one purpose.** Keep commits and PRs single-purpose, and state how you verified them (tests run, checks passed). Prefer a stack of small PRs over one omnibus diff.
- **Code changes are gated by antagonistic review where a project adopts it.** When a project's git-ops includes the `antagonistic-review-established` gate, every change is blocked behind an independent, adversarial review against the provisioned practices — a brief never has to ask for it. The gate fails loud: a reviewer that cannot run (no credential, out of tokens) blocks and surfaces the change, never self-merges, skips, or rewrites the check to get past it.
- **Trust git for merge state, not `gh`.** In a multi-repo workspace `gh` infers the repo from the current directory, so `gh pr view N` can silently report a _different_ repo's PR (tell-tale: a `mergedAt` that predates the PR's creation). Pass `--repo owner/name` on every `gh` call, and confirm a merge with git — `git fetch && git merge-base --is-ancestor <sha> origin/main` — not `gh pr view`.
