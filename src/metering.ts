import {
  sumUsages,
  estimateCostUSD,
  formatTokensCompact,
  catalogEntryFor,
  modelLabel,
  type PerModelUsage,
  type RatesTable,
  type RateTuple,
} from '@verevoir/llm';

// Metering (STDIO-385) — token + cost accounting for delegate / dispatch worker
// calls, the same primitives aigency-web uses (TokenUsage → estimateCostUSD over
// the catalog rate table). Three modes, set per call:
//   'none'        — nothing appended (default).
//   'totals-only' — one table at the end: model (concrete id) + class, in/out
//                   tokens, price.
//   'verbose'     — that table, plus a line per stage (each tool round) with the
//                   stage's tokens + price.
// The CONCRETE model id is what's metered/priced (version matters here even
// though config names the family — STDIO-378).

export type MeterMode = 'none' | 'totals-only' | 'verbose';

const METER_MODES: MeterMode[] = ['none', 'totals-only', 'verbose'];

/**
 * The effective meter mode (STDIO-387). An explicit per-call value wins;
 * otherwise the `AIGENCY_METER` env default (config-set, e.g. in the MCP server
 * env) applies; otherwise `none`. An unrecognised value — explicit or env —
 * falls through to `none` so a typo can't silently mean something unintended.
 */
export function resolveMeterMode(explicit?: MeterMode): MeterMode {
  if (explicit && METER_MODES.includes(explicit)) return explicit;
  const env = process.env.AIGENCY_METER?.trim() as MeterMode | undefined;
  if (env && METER_MODES.includes(env)) return env;
  return 'none';
}

/** A single round's usage: model id → input/output tokens. */
export function roundUsage(
  model: string,
  inputTokens: number,
  outputTokens: number
): PerModelUsage {
  return { [model]: { in: inputTokens, out: outputTokens } };
}

/** The rates for the models in a usage rollup, read from the catalog. */
function ratesFor(usage: PerModelUsage): RatesTable {
  const r: Record<string, RateTuple> = {};
  for (const id of Object.keys(usage)) {
    const rates = catalogEntryFor(id)?.rates;
    if (rates) r[id] = rates as RateTuple;
  }
  return r;
}

function priceUSD(usage: PerModelUsage): number {
  return estimateCostUSD(usage, ratesFor(usage));
}

/** One line per model in a rollup: "Label (class) — in / out — $price". */
function usageLines(usage: PerModelUsage): string[] {
  return Object.entries(usage).map(([id, u]) => {
    const cls = catalogEntryFor(id)?.modelClass ?? 'unclassified';
    const cost = priceUSD({ [id]: u });
    return `${modelLabel(id)} (${cls}) — ${formatTokensCompact(u.in)} in / ${formatTokensCompact(u.out)} out — $${cost.toFixed(4)}`;
  });
}

/**
 * The metering footer to append to a worker result, per mode. `rounds` is the
 * per-stage usage (one entry per tool round for dispatch, one for delegate);
 * `stageLabels` names each stage for `verbose`. Empty string for `'none'` or no
 * usage — so the caller can append unconditionally.
 */
export function meterFooter(
  rounds: PerModelUsage[],
  mode: MeterMode,
  stageLabels?: string[]
): string {
  if (mode === 'none' || rounds.length === 0) return '';
  const lines: string[] = [];
  if (mode === 'verbose') {
    lines.push('— metering by stage —');
    rounds.forEach((u, i) => {
      const label = stageLabels?.[i] ?? `round ${i + 1}`;
      lines.push(`  ${label}: ${usageLines(u).join('; ') || '(no usage)'}`);
    });
  }
  const total = sumUsages(rounds);
  lines.push('— metering total —');
  for (const l of usageLines(total)) lines.push(`  ${l}`);
  lines.push(`  total: $${priceUSD(total).toFixed(4)}`);
  return `\n\n${lines.join('\n')}`;
}
