// STDIO-519 — Mistral-coordinator harness: rendering the result. PURE over a
// RunResult — no I/O — so the layout is testable and the bin just prints what
// this returns.

import type { TokenUsage } from '@verevoir/llm';
import { classify, type CoordinationVerdict, type RoutingStep } from './verdict.js';
import type { RunResult } from './run.js';

const YES = '✓';
const NO = '✗';

/** The ordered routing trace: one line per recorded coordinator move. */
export function renderTrace(trace: RoutingStep[]): string {
  if (trace.length === 0) return '(no tool calls recorded)';
  return trace.map((s) => `  ${s.step}. ${s.tool} → ${s.model}  ·  ${s.argsSummary}`).join('\n');
}

/** The three-line verdict: one line per inverted-tier question. */
export function renderVerdict(v: CoordinationVerdict): string {
  const line = (ok: boolean, label: string) => `  ${ok ? YES : NO} ${label}`;
  return [
    line(v.escalatedReasoning, 'escalated-reasoning?  (architecture decision routed UP to opus)'),
    line(v.enactedCapability, 'enacted-capability?   (token production via enact_capability)'),
    line(v.delegatedLightDown, 'delegated-light-down? (README snippet routed DOWN to haiku)'),
  ].join('\n');
}

/** The usage line — the four token counts on the aggregated loop usage. */
function renderUsage(usage: TokenUsage | undefined): string {
  if (!usage) return 'Usage: (none)';
  const { inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens } = usage;
  return (
    `Usage: ${inputTokens} in / ${outputTokens} out` +
    ` (cache ${cacheReadInputTokens} read, ${cacheCreationInputTokens} write)`
  );
}

/** The full report for one coordination run: trace, verdict, overall tag,
 * mistral's final text, and usage. */
export function renderReport(result: RunResult): string {
  const header = `Mistral-coordinator harness — ${result.model}${result.modelId ? ` (${result.modelId})` : ''}`;
  if (result.unavailable) {
    return [header, '', `unavailable — ${result.unavailable}`].join('\n');
  }

  const verdict = classify(result.trace);
  const overall = verdict.coordinates
    ? 'coordinates — routed reasoning up, enacted the capability, and delegated light work down'
    : 'does not coordinate — one or more routes were wrong';

  return [
    header,
    `Iterations: ${result.iterations}`,
    '',
    'Routing trace (step → tool → model · args)',
    renderTrace(result.trace),
    '',
    'Verdict',
    renderVerdict(verdict),
    '',
    `Overall: ${overall}`,
    '',
    'Final text',
    result.finalText || '(no final text)',
    '',
    renderUsage(result.usage),
  ].join('\n');
}
