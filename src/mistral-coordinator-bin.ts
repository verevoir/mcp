#!/usr/bin/env node
// STDIO-519 — Mistral-coordinator harness CLI.
//
//   npm run coord:mistral
//   npm run coord:mistral -- --model opus     (control: does opus drive the inverted tier?)
//
// Observes whether the coordinator model, driving a multi-turn tool loop over
// one coordination task, routes each piece to the right tier: the architecture
// decision UP to opus, the token production through enact_capability, the
// README snippet DOWN to haiku. Execution is STUBBED — the executor records the
// routing trace and returns plausible stubs; no real pipeline runs. The default
// term is `mistral`; `--model` swaps in a control. The coordinator model needs
// its provider's API key in the env; the run prints which var.

import { resolveModelByTerm, providerConnection, isProviderConfigured } from '@verevoir/llm';
import { warmRegistry } from './registry.js';
import { runCoordination } from './mistral-coordinator/run.js';
import { renderReport } from './mistral-coordinator/report.js';

const DEFAULT_MODEL = 'mistral';

export interface Args {
  model: string;
  maxIterations: number;
}

/** Parse `--model <term>` and `--max-iterations <n>` (also `--flag=value`).
 * Unknown flags are ignored; missing `--model` falls back to `mistral`. */
export function parseArgs(argv: string[]): Args {
  const args: Args = { model: DEFAULT_MODEL, maxIterations: 10 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const [flag, inlineValue] = eq >= 0 ? [arg.slice(0, eq), arg.slice(eq + 1)] : [arg, undefined];
    if (flag === '--model') {
      const value = (inlineValue ?? argv[++i] ?? '').trim();
      if (value) args.model = value;
    } else if (flag === '--max-iterations') {
      const value = Number(inlineValue ?? argv[++i]);
      if (Number.isFinite(value) && value > 0) args.maxIterations = Math.floor(value);
    }
  }
  return args;
}

/** The env var the coordinator model needs, resolved through its provider — so
 * an operator sees exactly what to set. `configuredOnly: false` so an
 * unconfigured model still names its var. */
export function envHint(model: string): string {
  const entry = resolveModelByTerm(model, { configuredOnly: false });
  if (!entry) return `  ${model}: no provider serves this term`;
  const conn = providerConnection(entry.provider);
  const env = conn?.apiKeyEnv ?? '(provider connection not registered)';
  const set = isProviderConfigured(entry.provider) ? 'set' : 'NOT set';
  return `  ${model} → ${entry.provider} (${entry.currentId}) needs ${env} — currently ${set}`;
}

export async function main(argv: string[], out: (s: string) => void): Promise<void> {
  const args = parseArgs(argv);
  await warmRegistry();
  out(`Coordinator: ${args.model}`);
  out(`Env key:\n${envHint(args.model)}`);
  out('');

  const result = await runCoordination({ model: args.model, maxIterations: args.maxIterations });
  out(renderReport(result));
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main(process.argv.slice(2), (s) => console.log(s)).catch((err: unknown) => {
    console.error(
      `mistral-coordinator harness failed: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(1);
  });
}
