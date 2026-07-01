#!/usr/bin/env node
// STDIO-517 — Tool-discovery eval CLI.
//
//   npm run eval:tool-discovery
//   npm run eval:tool-discovery -- --models opus,sonnet,gemini,deepseek
//   npm run eval:tool-discovery -- --no-steer      (neutral-prompt baseline)
//
// Measures whether a reasoning model, shown our MCP tools + the injected steer,
// ROUTES work to them as expected or does it inline. `--no-steer` swaps the
// packaged instructions for a neutral prompt so the steer's before/after delta
// is measurable. Each model needs its provider's API key in the env; the run
// prints which var, and a model with no key is reported `unavailable` rather
// than crashing the run.

import { resolveModelByTerm, providerConnection, isProviderConfigured } from '@verevoir/llm';
import { warmRegistry } from './registry.js';
import { runMatrix } from './tool-discovery/run.js';
import { renderReport } from './tool-discovery/report.js';

const DEFAULT_MODELS = ['opus', 'sonnet', 'gemini', 'deepseek'];

export interface Args {
  models: string[];
  noSteer: boolean;
}

/** Parse `--models a,b,c` and `--no-steer` (also `--flag=value`). Unknown flags
 * are ignored. Empty / missing `--models` falls back to the default set. */
export function parseArgs(argv: string[]): Args {
  const args: Args = { models: DEFAULT_MODELS, noSteer: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const [flag, inlineValue] = eq >= 0 ? [arg.slice(0, eq), arg.slice(eq + 1)] : [arg, undefined];
    if (flag === '--no-steer') args.noSteer = true;
    else if (flag === '--models') {
      const raw = inlineValue ?? argv[++i];
      const parsed = (raw ?? '')
        .split(',')
        .map((m) => m.trim())
        .filter(Boolean);
      if (parsed.length) args.models = parsed;
    }
  }
  return args;
}

/** The env var each model needs, resolved through its provider — reported so an
 * operator sees exactly what to set before a run. `configuredOnly: false` so an
 * unconfigured model still names its var (that's the point of the hint). */
export function envHints(models: string[]): string {
  const lines = models.map((term) => {
    const entry = resolveModelByTerm(term, { configuredOnly: false });
    if (!entry) return `  ${term}: no provider serves this term`;
    const conn = providerConnection(entry.provider);
    const env = conn?.apiKeyEnv ?? '(provider connection not registered)';
    const set = isProviderConfigured(entry.provider) ? 'set' : 'NOT set';
    return `  ${term} → ${entry.provider} (${entry.currentId}) needs ${env} — currently ${set}`;
  });
  return `Env keys per model:\n${lines.join('\n')}`;
}

export async function main(argv: string[], out: (s: string) => void): Promise<void> {
  const args = parseArgs(argv);
  await warmRegistry();
  out(`Models: ${args.models.join(', ')}`);
  out(`Steer: ${args.noSteer ? 'neutral baseline (--no-steer)' : 'packaged instructions'}`);
  out(envHints(args.models));
  out('');

  const results = await runMatrix({ models: args.models, noSteer: args.noSteer });
  out(
    renderReport(results, {
      steer: args.noSteer ? 'neutral baseline (--no-steer)' : 'packaged instructions (steer on)',
    })
  );
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main(process.argv.slice(2), (s) => console.log(s)).catch((err: unknown) => {
    console.error(
      `tool-discovery eval failed: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(1);
  });
}
