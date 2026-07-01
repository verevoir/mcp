#!/usr/bin/env node
// STDIO-521 — coordinator cost×quality harness CLI.
//
//   npm run coord:cost -- --model mistral            (full task — expensive)
//   npm run coord:cost -- --model opus --scoped      (cheap sibling task)
//   npm run coord:cost -- --model sonnet --scoped
//
// Runs ONE coordinator model through the un-stubbed pipeline over the same real
// workload and reports total cost (per tier) + gated output quality. This is the
// un-stubbed sibling of the STDIO-519 harness — here the tools the coordinator
// calls really run. Real execution needs API keys; the run prints which vars the
// coordinator model and the worker tier need before it starts.

import { resolveModelByTerm, providerConnection, isProviderConfigured } from '@verevoir/llm';
import { warmRegistry } from './registry.js';
import { runCoordination } from './coordinator-cost/run.js';
import { renderReport } from './coordinator-cost/report.js';

const DEFAULT_MODEL = 'mistral';

export interface Args {
  model: string;
  scoped: boolean;
  maxIterations: number;
  source?: string;
}

/** Parse `--model <term>`, `--scoped`, `--max-iterations <n>`, `--source <url>`
 * (also `--flag=value`). Unknown flags are ignored; missing `--model` falls back
 * to `mistral`. */
export function parseArgs(argv: string[]): Args {
  const args: Args = { model: DEFAULT_MODEL, scoped: false, maxIterations: 15 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const [flag, inlineValue] = eq >= 0 ? [arg.slice(0, eq), arg.slice(eq + 1)] : [arg, undefined];
    if (flag === '--model') {
      const value = (inlineValue ?? argv[++i] ?? '').trim();
      if (value) args.model = value;
    } else if (flag === '--scoped') {
      args.scoped = true;
    } else if (flag === '--source') {
      const value = (inlineValue ?? argv[++i] ?? '').trim();
      if (value) args.source = value;
    } else if (flag === '--max-iterations') {
      const value = Number(inlineValue ?? argv[++i]);
      if (Number.isFinite(value) && value > 0) args.maxIterations = Math.floor(value);
    }
  }
  return args;
}

/** The env var a term's provider needs, resolved through its connection — so an
 * operator sees exactly what to set. `configuredOnly: false` so an unconfigured
 * model still names its var. */
export function envHint(term: string): string {
  const entry = resolveModelByTerm(term, { configuredOnly: false });
  if (!entry) return `  ${term}: no provider serves this term`;
  const conn = providerConnection(entry.provider);
  const env = conn?.apiKeyEnv ?? '(provider connection not registered)';
  const set = isProviderConfigured(entry.provider) ? 'set' : 'NOT set';
  return `  ${term} → ${entry.provider} (${entry.currentId}) needs ${env} — currently ${set}`;
}

/** The keys the run needs: the coordinator model's provider key, the reasoning
 * tier (for the enact's review + any opus route), and the worker tier (for
 * enact production + any delegate). */
export function envKeys(model: string): string {
  return [
    'Env keys needed:',
    envHint(model),
    '  worker/enact tier — AIGENCY_MODEL_EXTRACTION (+ _URI / _KEY) or AIGENCY_WORKER_MODEL',
    '  reasoning tier (enact review + opus route) — AIGENCY_MODEL_REASONING or ANTHROPIC_API_KEY',
  ].join('\n');
}

export async function main(argv: string[], out: (s: string) => void): Promise<void> {
  const args = parseArgs(argv);
  await warmRegistry();
  out(
    `Coordinator: ${args.model}  ·  task: ${args.scoped ? 'scoped (cheap)' : 'full (expensive)'}`
  );
  out(envKeys(args.model));
  out('');

  const result = await runCoordination({
    model: args.model,
    scoped: args.scoped,
    maxIterations: args.maxIterations,
    source: args.source,
  });
  out(renderReport(result));
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main(process.argv.slice(2), (s) => console.log(s)).catch((err: unknown) => {
    console.error(
      `coordinator-cost harness failed: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(1);
  });
}
