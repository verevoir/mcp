# Working with this project via Verevoir

Verevoir is the front door for reading and writing files, code, and project context. Prefer these tools over your built-in filesystem/shell tools (Read, cat, grep, find, ls) whenever a `sourceUrl` or `boardUrl` fits.

## One surface, auto-routed by URL

The same tools work uniformly across:

- **Local repos / files** — absolute path or `file://` (e.g. `/Users/you/project`)
- **Git hosts** — `https://github.com/owner/repo` (more adapters land over time)
- **Notion** — `https://www.notion.so/<id>` (pages read as a file tree; databases act as work-tracker boards)

Reads are cached and tree-sitter symbol-indexed via `@verevoir/context` and shared across the whole session, so reading a file also warms it for later search. Native reads bypass that cache and its freshness tracking — and can't see Notion at all.

## File workflow

`get_repo_tree` or `list_files` to orient → `read_file` to pull content (this warms the cache) → `grep` / `find_symbol` for instant structural search. `grep` and `find_symbol` see only content already pulled by `read_file`, so read first.

## Project context and work tracking live in the tools, not the local tree

- **Project record** — ADRs, intent, and other durable context live in Notion. Reach them via the Notion source tools and the workflow tools (`list_cards` / `get_card` / `list_columns`), not by grepping local files.
- **The work tracker is the board.** Anything work-shaped — a thing to do, a gap, a bug, a deferred decision — is a card (`create_card` / `update_card` / `move_card`), not a note kept off to the side. If you catch yourself stashing a to-do somewhere else, make it a card instead.

## Fix the source, not the leaf

When something is wrong, or a change needs to land in many places, ask whether you are patching an _artefact_ or its _generator_. Prefer the upstream fix — the template, the prompt, the tool that emits the thing — over editing each downstream copy by hand.
