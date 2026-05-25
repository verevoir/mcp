import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerSourceTools } from './tools/source.js';
import { registerWorkflowTools } from './tools/workflow.js';
import { loadInstructions } from './instructions.js';

/** Construct and configure the MCP server. The caller is responsible for
 * wiring a transport (see bin.ts). */
export function createServer(): McpServer {
  const server = new McpServer(
    {
      name: 'verevoir-mcp',
      version: '0.1.0',
    },
    // Server-level guidance the client injects into the model's context on
    // connect — the lever that makes an agent prefer these tools over its
    // built-in filesystem/shell tools. Loaded from the packaged doctrine doc
    // (instructions.md) so it's editable as a doc, not a buried string literal.
    { instructions: loadInstructions() }
  );

  registerSourceTools(server);
  registerWorkflowTools(server);

  return server;
}
