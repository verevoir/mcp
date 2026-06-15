# Working with this project via Verevoir

Verevoir is the front door for reading and writing files, code, and project context. These tools share a cache + tree-sitter index across the whole session; your built-in filesystem/shell tools do not — so reaching for them in preference is not a style nicety, it keeps that shared view correct.

- **Writes — always through the MCP.** Make every change to a covered `sourceUrl` / `boardUrl` with `write_file` / `edit_file` (or the card tools). A write that goes around them — shell redirection, `sed -i`, or the built-in Edit/Write on a covered path — leaves the shared cache stale and _wrong_ for the rest of the session, so later reads and searches serve pre-write content. This is the firm rule: never edit a covered file out-of-band.
- **Reads — prefer the MCP.** Use `read_file` / `grep` / `find_symbol` over the built-in Read / `cat` / shell `grep` / `find` / `ls`. A bypassed read is less costly than a bypassed write — it only misses the cache + index benefit (slower, duplicate fetches, no Notion) rather than corrupting state — but the MCP is still the default whenever a `sourceUrl` fits.

## Before you change code, consult the bar

Before you implement, write, or change code, call **`provision`** with a short description of the work. It returns the **practices your output is held to** — in one call, as text, not an index to chase. Treat this as a precondition for the change, the same way writing through the MCP is: skip it and your code is judged against standards you never read. If you hand the work to another model, the practices must travel with it — a floor worker won't fetch the bar itself. The **`delegate`** tool does this for you by default (it provisions the task and carries the frame to the worker); for a sub-agent you spawn another way, pass the returned frame in its prompt yourself. (`find_governance` is still there for browsing the wider record; `provision` is the triggered shortcut for "what am I held to for _this_.")

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
- **Trust git for merge state, not `gh`.** In a multi-repo workspace `gh` infers the repo from the current directory, so `gh pr view N` can silently report a _different_ repo's PR (tell-tale: a `mergedAt` that predates the PR's creation). Pass `--repo owner/name` on every `gh` call, and confirm a merge with git — `git fetch && git merge-base --is-ancestor <sha> origin/main` — not `gh pr view`.
