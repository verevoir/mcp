#!/usr/bin/env node
import { watchA2A } from './a2a-watch.js';

// Watch a dispatch run over the A2A surface, rendering status-update events as
// they stream (STDIO-395). Point it at a running verevoir-a2a server.
//
//   PORT=4100 verevoir-a2a                                  # server, one shell
//   MODEL=deepseek SOURCE=/path/to/repo \
//     verevoir-a2a-watch "review src/foo.ts"                # watcher, another

const baseUrl = process.env.A2A_URL?.trim() || `http://127.0.0.1:${process.env.PORT ?? 4100}`;
const prompt = process.argv.slice(2).join(' ');
const model = process.env.MODEL?.trim() || 'deepseek';
const source = process.env.SOURCE?.trim() || process.cwd();

if (!prompt) {
  process.stderr.write(
    'usage: verevoir-a2a-watch "<task prompt>"   (MODEL, SOURCE, A2A_URL/PORT via env)\n'
  );
  process.exit(1);
}

watchA2A({
  baseUrl,
  prompt,
  model,
  source,
  render: (line) => process.stdout.write(`${line}\n`),
}).catch((err: unknown) => {
  process.stderr.write(`verevoir-a2a-watch: ${String(err)}\n`);
  process.exit(1);
});
