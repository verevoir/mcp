#!/usr/bin/env node
import { serveA2A, DEFAULT_A2A_HOST } from './a2a.js';

// Standalone A2A server over the dispatch runtime (STDIO-382). Opt-in, separate
// from the stdio MCP: start it to expose dispatch as an A2A agent — Agent Card
// at /.well-known/agent.json, JSON-RPC message/send + tasks/get, SSE streaming.
//
//   PORT=4100 verevoir-a2a
//   curl 127.0.0.1:4100/.well-known/agent.json
//
// Binds loopback (127.0.0.1) by default — the server has NO authentication, so
// it must not be reachable off-host. To expose it deliberately, set HOST (e.g.
// HOST=0.0.0.0) AND put it behind your own auth/network controls (STDIO-398).

const port = Number(process.env.PORT ?? 4100);
const host = process.env.HOST?.trim() || DEFAULT_A2A_HOST;
const version = process.env.npm_package_version ?? '0.0.0';

serveA2A({ port, host, version });
const exposed = host !== DEFAULT_A2A_HOST ? '  [WARNING: bound off-loopback, no auth]' : '';
process.stderr.write(
  `verevoir-a2a: listening on http://${host}:${port}  (agent card: /.well-known/agent.json)${exposed}\n`
);
