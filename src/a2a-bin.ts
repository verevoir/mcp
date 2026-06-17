#!/usr/bin/env node
import { serveA2A } from './a2a.js';

// Standalone A2A server over the dispatch runtime (STDIO-382). Opt-in, separate
// from the stdio MCP: start it to expose dispatch as an A2A agent — Agent Card
// at /.well-known/agent.json, JSON-RPC message/send + tasks/get, SSE streaming.
//
//   PORT=4100 verevoir-a2a
//   curl localhost:4100/.well-known/agent.json

const port = Number(process.env.PORT ?? 4100);
const version = process.env.npm_package_version ?? '0.0.0';

serveA2A({ port, version });
process.stderr.write(
  `verevoir-a2a: listening on http://localhost:${port}  (agent card: /.well-known/agent.json)\n`
);
