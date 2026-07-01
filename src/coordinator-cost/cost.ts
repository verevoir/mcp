// STDIO-521 — coordinator cost×quality harness: the pure cost aggregation.
//
// The un-stubbed executor records one {@link RecordedCall} per real tool call
// (the tool, the model that actually ran, the tokens in/out, the wall-clock).
// This module rolls those calls up into a per-model, per-tier breakdown with a
// $ estimate from the adapter rate tables — no I/O, no model calls, so the whole
// aggregation is unit-testable without a network.
//
// The $ estimate is best-effort: a model the catalog can't price contributes 0
// dollars but keeps its tokens, and is named in `uncovered` so the report can
// say "we billed something we couldn't price" rather than showing a silent
// under-count.

import {
  estimateCostUSD,
  catalogEntryFor,
  modelLabel,
  type PerModelUsage,
  type RateTuple,
  type RatesTable,
  type ModelClass,
} from '@verevoir/llm';

/** One real tool call the executor ran, with what it cost. `model` is the
 * concrete id that actually ran (the coordinator's own id, or the worker/tier a
 * delegate/enact resolved to); `'(none)'` when the call ran no model (a
 * read/write handled inline). */
export interface RecordedCall {
  /** The tool the coordinator called (`enact_capability`, `delegate`, …). */
  tool: string;
  /** The concrete model id that ran the work, or `'(none)'` for an inline call. */
  model: string;
  tokensIn: number;
  tokensOut: number;
  /** Wall-clock for the call, ms. */
  ms: number;
}

/** The role a model played in the run, so the breakdown reads as tiers rather
 * than a flat model list. The coordinator is the driving model; a delegate/enact
 * runs work on the worker/opus/haiku tier. */
export type TierRole = 'coordinator' | 'reasoning' | 'light' | 'worker' | 'other';

/** A per-model line in the breakdown: the model, the tier role it played, its
 * summed tokens, and its $ estimate (0 when uncatalogued). */
export interface ModelSpend {
  model: string;
  label: string;
  role: TierRole;
  modelClass: ModelClass | 'unclassified';
  tokensIn: number;
  tokensOut: number;
  calls: number;
  costUSD: number;
  /** True when no catalog rate priced this model — its `costUSD` is 0 but its
   * tokens are real. */
  uncosted: boolean;
}

/** The whole-run cost breakdown: one line per model that ran, plus totals and
 * the models that couldn't be priced. */
export interface CostBreakdown {
  perModel: ModelSpend[];
  totalTokensIn: number;
  totalTokensOut: number;
  totalCostUSD: number;
  /** True when every model that ran had a catalog rate — so the $ total is
   * complete, not an under-count. */
  fullyCosted: boolean;
  /** The concrete ids that ran but couldn't be priced. */
  uncosted: string[];
}

/** Which tier role a call played, from its tool and the model that ran it. The
 * coordinator's own model is the driving model; a routing tool naming opus is
 * reasoning-tier, naming haiku is light-tier, else it's the worker tier. */
export function roleOf(call: RecordedCall, coordinatorModel: string): TierRole {
  if (call.tool === '(coordinator loop)' || call.model === coordinatorModel) return 'coordinator';
  const id = call.model.toLowerCase();
  if (id.includes('opus')) return 'reasoning';
  if (id.includes('haiku')) return 'light';
  if (call.tool === 'enact_capability' || call.tool === 'delegate' || call.tool === 'dispatch') {
    return 'worker';
  }
  return 'other';
}

/** The catalog rates for the models in a usage rollup, best-effort — a model the
 * catalog can't price is simply absent, contributing 0 to the estimate. */
function ratesFor(usage: PerModelUsage): RatesTable {
  const table: Record<string, RateTuple> = {};
  for (const id of Object.keys(usage)) {
    const rates = catalogEntryFor(id)?.rates;
    if (rates) table[id] = rates as RateTuple;
  }
  return table;
}

/**
 * Aggregate recorded calls into a per-model, per-tier cost breakdown. PURE.
 *
 * Calls that ran no model (`model: '(none)'` — an inline read/write) contribute
 * neither tokens nor cost; only real model calls appear. A model the catalog
 * can't price keeps its tokens but scores $0 and is listed in `uncosted`, so a
 * reader can see the total is a floor, not the full spend.
 *
 * `coordinatorModel` is the concrete id the coordinator itself ran on, so its
 * own driving spend is tagged `coordinator` and separated from the tiers it
 * routed work to.
 */
export function aggregateCost(calls: RecordedCall[], coordinatorModel: string): CostBreakdown {
  const byModel = new Map<
    string,
    { role: TierRole; tokensIn: number; tokensOut: number; calls: number }
  >();

  for (const call of calls) {
    if (call.model === '(none)') continue;
    const existing = byModel.get(call.model) ?? {
      role: roleOf(call, coordinatorModel),
      tokensIn: 0,
      tokensOut: 0,
      calls: 0,
    };
    existing.tokensIn += call.tokensIn;
    existing.tokensOut += call.tokensOut;
    existing.calls += 1;
    byModel.set(call.model, existing);
  }

  const perModel: ModelSpend[] = [];
  const uncosted: string[] = [];
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let totalCostUSD = 0;

  for (const [model, agg] of byModel) {
    const usage: PerModelUsage = { [model]: { in: agg.tokensIn, out: agg.tokensOut } };
    const rates = ratesFor(usage);
    const priced = model in rates;
    const costUSD = priced ? estimateCostUSD(usage, rates) : 0;
    if (!priced) uncosted.push(model);
    totalTokensIn += agg.tokensIn;
    totalTokensOut += agg.tokensOut;
    totalCostUSD += costUSD;
    perModel.push({
      model,
      label: modelLabel(model),
      role: agg.role,
      modelClass: catalogEntryFor(model)?.modelClass ?? 'unclassified',
      tokensIn: agg.tokensIn,
      tokensOut: agg.tokensOut,
      calls: agg.calls,
      costUSD,
      uncosted: !priced,
    });
  }

  // Order the breakdown by tier role (coordinator first, then the tiers it
  // routed to) so the split reads top-down, then by spend within a role.
  const rank: Record<TierRole, number> = {
    coordinator: 0,
    reasoning: 1,
    worker: 2,
    light: 3,
    other: 4,
  };
  perModel.sort(
    (a, b) => rank[a.role] - rank[b.role] || b.tokensIn + b.tokensOut - (a.tokensIn + a.tokensOut)
  );

  return {
    perModel,
    totalTokensIn,
    totalTokensOut,
    totalCostUSD,
    fullyCosted: uncosted.length === 0,
    uncosted,
  };
}
