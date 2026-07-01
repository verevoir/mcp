#!/usr/bin/env node
// STDIO-520 — plan-first coordinator harness CLI.
//
//   npm run coord:plan -- --model opus            (full task — expensive)
//   npm run coord:plan -- --model opus --scoped   (cheap sibling task)
//
// Runs ONE coordinator PLAN-FIRST over the same real workload the tool-loop
// harness (coord:cost) uses, and reports the plan (the DAG + the parallel
// layers), the gate verdict, per-node + per-tier cost, quality, and wall-clock —
// so plan-first's cost and parallel structure sit next to the improvising
// tool-loop run. Real execution needs API keys; the run prints which vars the
// coordinator model and the worker tier need before it starts.

import { resolveModelByTerm, providerConnection, isProviderConfigured } from '@verevoir/llm';
import { warmRegistry } from './registry.js';
import {
  planFirstCoordination,
  type PlanFirstResult,
} from './coordinator-cost/plan-coordinator.js';
import { renderCost, renderQuality } from './coordinator-cost/report.js';

const DEFAULT_MODEL = 'opus';

export interface Args {
  model: string;
  scoped: boolean;
}

/** Parse `--model <term>` and `--scoped` (also `--flag=value`). Unknown flags are
 * ignored; a missing `--model` falls back to `opus` (the reasoning tier both
 * plans and reviews on). */
export function parseArgs(argv: string[]): Args {
  const args: Args = { model: DEFAULT_MODEL, scoped: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const [flag, inlineValue] = eq >= 0 ? [arg.slice(0, eq), arg.slice(eq + 1)] : [arg, undefined];
    if (flag === '--model') {
      const value = (inlineValue ?? argv[++i] ?? '').trim();
      if (value) args.model = value;
    } else if (flag === '--scoped') {
      args.scoped = true;
    }
  }
  return args;
}

/** The env var a term's provider needs — so an operator sees exactly what to set. */
export function envHint(term: string): string {
  const entry = resolveModelByTerm(term, { configuredOnly: false });
  if (!entry) return `  ${term}: no provider serves this term`;
  const conn = providerConnection(entry.provider);
  const env = conn?.apiKeyEnv ?? '(provider connection not registered)';
  const set = isProviderConfigured(entry.provider) ? 'set' : 'NOT set';
  return `  ${term} → ${entry.provider} (${entry.currentId}) needs ${env} — currently ${set}`;
}

/** The keys the plan-first run needs: the coordinator (which selects entries on
 * its own tier), the reasoning tier (entry selection + enact review), and the
 * worker tier (enact production). */
export function envKeys(model: string): string {
  return [
    'Env keys needed:',
    envHint(model),
    '  worker/enact tier — AIGENCY_MODEL_EXTRACTION (+ _URI / _KEY) or AIGENCY_WORKER_MODEL',
    '  reasoning tier (entry selection + enact review) — AIGENCY_MODEL_REASONING or ANTHROPIC_API_KEY',
  ].join('\n');
}

/** Render the plan itself — the DAG (each node, its source, and what it depends
 * on) and the execution layers, so the parallel width is visible next to the
 * dependency depth. */
export function renderPlan(result: PlanFirstResult): string {
  const { plan, layers } = result;
  const nodeLines = plan.nodes.map((n) => {
    const deps = n.dependsOn.length ? ` ← ${n.dependsOn.join(', ')}` : ' (no deps)';
    return `  · ${n.capability} [${n.source}]${deps}`;
  });
  const layerLines = layers.map(
    (layer, i) => `  layer ${i} (${layer.length} parallel): ${layer.join(', ')}`
  );
  return [
    `Plan — ${plan.nodes.length} node(s), entry: ${plan.entry.join(', ') || '(none)'}`,
    ...(nodeLines.length ? nodeLines : ['  (no nodes)']),
    '',
    `Layers — ${layers.length} deep, widest ${Math.max(0, ...layers.map((l) => l.length))} wide`,
    ...(layerLines.length ? layerLines : ['  (not executed)']),
  ].join('\n');
}

/** The full plan-first report: header, plan (DAG + layers), gate verdict, cost,
 * quality, and wall-clock. Self-contained so it sits beside a tool-loop report. */
export function renderPlanReport(result: PlanFirstResult): string {
  const header =
    `Plan-first coordinator — ${result.model}` +
    `${result.modelId ? ` (${result.modelId})` : ''} · ${result.scoped ? 'scoped task' : 'full task'}`;
  if (result.aborted && result.plan.nodes.length === 0) {
    return [header, '', `aborted — ${result.aborted}`].join('\n');
  }

  const gateLine = result.gate.ok
    ? '  ✓ gate PASS — plan is non-empty, acyclic, every entry + dependency resolves'
    : ['  ✗ gate FAIL — plan NOT executed', ...result.gate.findings.map((f) => `    · ${f}`)].join(
        '\n'
      );
  const overallQuality = result.quality.passes
    ? 'quality PASS — gate green and every done-well check met'
    : 'quality FAIL — gate or a done-well check not met';
  const failedLine = result.failed.length
    ? `  ${result.failed.length} node(s) failed: ${result.failed.join(', ')}`
    : '  all nodes succeeded';

  return [
    header,
    `Run: ${result.wallClockMs} ms wall-clock`,
    '',
    renderPlan(result),
    '',
    'Gate (inspect before you spend)',
    gateLine,
    '',
    'Cost (per tier)',
    renderCost(result.cost),
    '',
    'Execution',
    failedLine,
    '',
    'Quality',
    renderQuality(result.quality),
    `  Overall: ${overallQuality}`,
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

  const result = await planFirstCoordination({ model: args.model, scoped: args.scoped });
  out(renderPlanReport(result));
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main(process.argv.slice(2), (s) => console.log(s)).catch((err: unknown) => {
    console.error(
      `plan-first coordinator harness failed: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(1);
  });
}
