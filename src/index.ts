import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerSourceTools } from './tools/source.js';
import { registerWorkflowTools } from './tools/workflow.js';

/** Construct and configure the MCP server. The caller is responsible for
 * wiring a transport (see bin.ts). */
export function createServer(): McpServer {
  const server = new McpServer({
    name: 'verevoir-mcp',
    version: '0.1.0',
  });

  registerSourceTools(server);
  registerWorkflowTools(server);

  return server;
}
