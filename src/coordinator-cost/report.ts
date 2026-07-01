// STDIO-521 — coordinator cost×quality harness: rendering the result. PURE over
// a RunResult — no I/O — so the layout is testable and the bin just prints it.
//
// The report is structured so several coordinators' reports sit side by side:
// each is a self-contained block headed by the coordinator, then the cost
// breakdown (per tier), the quality verdict (gate + checklist), the run shape
// (passes / iterations / budget), and the routing trace.

import { formatTokensCompact } from '@verevoir/llm';
import type { RunResult } from './run.js';
import type { CostBreakdown, TierRole } from './cost.js';
import type { QualityVerdict } from './quality.js';
import type { RecordedCall } from './cost.js';

const YES = '✓';
const NO = '✗';

const ROLE_LABEL: Record<TierRole, string> = {
  coordinator: 'coordinator',
  reasoning: 'reasoning (opus)',
  worker: 'worker (enact/delegate)',
  light: 'light (haiku)',
  other: 'other',
};

/** The per-tier cost breakdown: one line per model that ran, tagged by tier
 * role, then the totals and any uncosted models. */
export function renderCost(cost: CostBreakdown): string {
  if (cost.perModel.length === 0) return '  (no model spend recorded)';
  const lines = cost.perModel.map((m) => {
    const dollars = m.uncosted ? 'uncosted' : `$${m.costUSD.toFixed(4)}`;
    // Surface cache-read separately — a coordinator's spend is mostly re-sent
    // (cached) context, and showing it makes the small fresh-input number read
    // sensibly against the cost.
    const cache =
      m.cacheRead || m.cacheWrite
        ? ` (+${formatTokensCompact(m.cacheRead)} cache-read` +
          (m.cacheWrite ? `, ${formatTokensCompact(m.cacheWrite)} cache-write` : '') +
          ')'
        : '';
    return (
      `  ${ROLE_LABEL[m.role]}: ${m.label} — ` +
      `${formatTokensCompact(m.tokensIn)} in${cache} / ${formatTokensCompact(m.tokensOut)} out ` +
      `over ${m.calls} call(s) — ${dollars}`
    );
  });
  const costed = cost.fullyCosted
    ? `$${cost.totalCostUSD.toFixed(4)}`
    : `$${cost.totalCostUSD.toFixed(4)} (floor — ${cost.uncosted.length} model(s) uncosted: ${cost.uncosted.join(', ')})`;
  lines.push(
    `  total: ${formatTokensCompact(cost.totalTokensIn)} in / ${formatTokensCompact(cost.totalTokensOut)} out — ${costed}`
  );
  return lines.join('\n');
}

/** The quality verdict: the deterministic gate line, the done-well checklist,
 * and the overall pass. */
export function renderQuality(q: QualityVerdict): string {
  if (!q.foundTokens) {
    return [
      '  gate: n/a — no DTCG token set produced',
      ...q.gateFindings.map((f) => `    · ${f}`),
    ].join('\n');
  }
  const lines: string[] = [];
  lines.push(
    `  ${q.gateOk ? YES : NO} design-gate (DTCG valid, no value-drift, drift-gate emitted)`
  );
  for (const f of q.gateFindings) lines.push(`    · ${f}`);
  for (const item of q.checklist) {
    lines.push(`  ${item.ok ? YES : NO} ${item.label} — ${item.detail}`);
  }
  return lines.join('\n');
}

/** The routing trace: one line per recorded call, in order, with tool → model
 * and its tokens. The `(coordinator loop)` and inline read/grep/write calls sit
 * in the same ordered trace so the whole run reads top-to-bottom. */
export function renderTrace(calls: RecordedCall[]): string {
  if (calls.length === 0) return '  (no calls recorded)';
  return calls
    .map((c, i) => {
      const tokens =
        c.tokensIn || c.tokensOut
          ? ` · ${formatTokensCompact(c.tokensIn)} in / ${formatTokensCompact(c.tokensOut)} out`
          : '';
      return `  ${i + 1}. ${c.tool} → ${c.model}${tokens}`;
    })
    .join('\n');
}

/** The full report for one coordinator run: header, run shape, cost, quality,
 * trace, and final text. Self-contained so several stack side by side. */
export function renderReport(result: RunResult): string {
  const header =
    `Coordinator cost×quality — ${result.model}` +
    `${result.modelId ? ` (${result.modelId})` : ''} · ${result.scoped ? 'scoped task' : 'full task'}`;
  if (result.unavailable) {
    return [header, '', `unavailable — ${result.unavailable}`].join('\n');
  }

  const shape =
    `Run: ${result.passes} pass(es), ${result.iterations} model call(s)` +
    `${result.budgetTripped ? ' — STOPPED on output-token budget' : ''}`;
  const overallQuality = result.quality.passes
    ? 'quality PASS — gate green and every done-well check met'
    : 'quality FAIL — gate or a done-well check not met';

  return [
    header,
    shape,
    '',
    'Cost (per tier)',
    renderCost(result.cost),
    '',
    'Quality',
    renderQuality(result.quality),
    `  Overall: ${overallQuality}`,
    '',
    'Routing trace (order · tool → model · tokens)',
    renderTrace(result.log.calls),
    '',
    'Final text',
    result.finalText || '(no final text)',
  ].join('\n');
}
