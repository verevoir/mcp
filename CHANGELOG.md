# Changelog

## 0.1.0 — 2026-05-24

Initial release.

- `@verevoir/mcp` — MCP server exposing the Verevoir substrate as Claude-Code-usable tools. Stdio transport. Bin entry `verevoir-mcp`.
- 6 source tools (`read_file`, `list_files`, `get_repo_tree`, `grep`, `find_symbol`, `write_file`) backed by `@verevoir/context/github` + `@verevoir/context/fs`. URL-pattern routing.
- 8 workflow tools (`list_columns`, `list_cards`, `get_card`, `create_card`, `update_card`, `move_card`, `list_comments`, `add_comment`) backed by `@verevoir/workflows/trello`.
- Auth via env vars (`GITHUB_TOKEN`, `TRELLO_API_KEY` + `TRELLO_API_TOKEN` + `TRELLO_REFERER`). Per-tool failure with clear messages when required env is missing.
- 11 unit tests covering URL routing across source kinds + the unsupported-URL throw path.
