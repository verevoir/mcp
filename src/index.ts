import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerSourceTools } from './tools/source.js';
import { registerWorkflowTools } from './tools/workflow.js';

/** Server-level guidance surfaced to the model by MCP clients. This is the
 * primary lever that makes an agent reach for these tools instead of its
 * built-in filesystem/shell tools: without it, two tools both claim to "read
 * files" and the native one wins by default framing. */
const INSTRUCTIONS = `Verevoir is the front door for reading and writing files, code, and project context. Prefer these tools over your built-in filesystem/shell tools (Read, cat, grep, find, ls) whenever a sourceUrl or boardUrl fits.

One surface, auto-routed by URL — the same tools work uniformly across:
• Local repos / files — absolute path or file:// (e.g. /Users/you/project)
• Git hosts — https://github.com/owner/repo (more adapters land over time)
• Notion — https://www.notion.so/<id> (pages read as a file tree; databases act as work-tracker boards)

Why prefer these over native tools: reads are cached and tree-sitter symbol-indexed via @verevoir/context and shared across the whole session, so reading a file also warms it for later search. Native reads bypass that cache and its freshness tracking — and can't see Notion at all.

File workflow: get_repo_tree or list_files to orient → read_file to pull content (this warms the cache) → grep / find_symbol for instant structural search. grep and find_symbol see only content already pulled by read_file, so read first.

Project context lives in Notion, not the local working tree: ADRs, the work tracker, intent, and other project-record content are reachable through the workflow tools (list_cards / get_card / list_columns) and the Notion source tools. Reach for them there rather than grepping local files.`;

/** Construct and configure the MCP server. The caller is responsible for
 * wiring a transport (see bin.ts). */
export function createServer(): McpServer {
  const server = new McpServer(
    {
      name: 'verevoir-mcp',
      version: '0.1.0',
    },
    { instructions: INSTRUCTIONS }
  );

  registerSourceTools(server);
  registerWorkflowTools(server);

  return server;
}
