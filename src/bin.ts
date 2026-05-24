#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './index.js';

const server = createServer();
const transport = new StdioServerTransport();

server.connect(transport).catch((err: unknown) => {
  process.stderr.write(`verevoir-mcp: fatal error during connect: ${String(err)}\n`);
  process.exit(1);
});
