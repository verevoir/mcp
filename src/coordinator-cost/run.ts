// STDIO-521 — coordinator cost×quality harness: the runner.
//
// Drives one coordinator model through the un-stubbed tool loop over ONE real
// workload, so mistral / opus / sonnet can be compared on the SAME task by total
// cost (per-tier) and output quality (gated). The executor (executor.ts) runs the
// real tools the coordinator calls; this runner wires it to `chatWithToolLoop`,
// handles the most-expansive auto-answer, and guards the run with an iteration
// cap and an output-token budget.
//
// Two guards keep an un-stubbed run bounded:
//   - a maxIterations cap on each tool-loop pass (default 15); and
//   - an output-token budget (default ~150k): the executor trips an AbortSignal
//     once the recorded output tokens cross the cap, so the loop stops cleanly
//     between iterations rather than running away.
//
// Model resolution mirrors the sibling STDIO-519 harness: a term resolves to a
// { provider, modelClass } via `resolveModelByTerm`, and that provider's adapter
// drives `chatWithToolLoop`.

import type {
  ChatWithToolLoopOptions,
  ChatWithToolLoopResult,
  ModelClass,
  ToolDef,
  Turn,
} from '@verevoir/llm';
import { resolveModelByTerm } from '@verevoir/llm';
import { warmRegistry, importProviderAdapter } from '../registry.js';
import { loadInstructions } from '../instructions.js';
import { COORDINATOR_TOOLS } from './tools.js';
import { taskFor, MOST_EXPANSIVE_ANSWER } from './task.js';
import {
  makeExecutor,
  emptyLog,
  producedForGate,
  type ExecutionLog,
  type ExecutorDeps,
} from './executor.js';
import { aggregateCost, type CostBreakdown } from './cost.js';
import { judgeQuality, type QualityVerdict } from './quality.js';

interface ToolLoopAdapter {
  chatWithToolLoop?: (options: ChatWithToolLoopOptions) => Promise<ChatWithToolLoopResult>;
}

interface ResolvedModel {
  provider: string;
  modelClass: ModelClass;
  modelId: string;
  adapter: ToolLoopAdapter;
}

/** Resolve a term to a tool-loop-capable coordinator model, or a legible reason
 * it can't be driven. Never throws. */
export async function resolveCoordinator(
  term: string
): Promise<ResolvedModel | { unavailable: string }> {
  const entry = resolveModelByTerm(term);
  if (!entry) {
    return { unavailable: `no configured provider serves "${term}" (is its API key set?)` };
  }
  const load = importProviderAdapter(entry.provider);
  if (!load) return { unavailable: `provider "${entry.provider}" is unknown` };
  const adapter = (await load.catch(() => undefined)) as ToolLoopAdapter | undefined;
  if (!adapter) return { unavailable: `provider "${entry.provider}" adapter did not load` };
  if (typeof adapter.chatWithToolLoop !== 'function') {
    return {
      unavailable: `provider "${entry.provider}" has no chatWithToolLoop (tool loop unsupported)`,
    };
  }
  return {
    provider: entry.provider,
    modelClass: entry.modelClass ?? 'reasoning',
    modelId: entry.currentId,
    adapter,
  };
}

/** Whether a text-only reply reads as a scope / clarifying question the harness
 * should auto-answer maximally, rather than a final report. A reply that asks
 * something (ends with, or contains, a question) and did no tool work is a pause
 * for scope. */
export function looksLikeScopeQuestion(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  return t.includes('?');
}

export interface RunResult {
  model: string;
  modelId?: string;
  provider?: string;
  scoped: boolean;
  /** Set when the coordinator couldn't be driven at all. */
  unavailable?: string;
  /** How many tool-loop passes ran (one per auto-answer round). */
  passes: number;
  /** Total model calls the coordinator made across all passes. */
  iterations: number;
  /** The coordinator's final text after the loop. */
  finalText: string;
  /** True when the output-token budget tripped the abort. */
  budgetTripped: boolean;
  /** The per-tier cost breakdown across every recorded call. */
  cost: CostBreakdown;
  /** The gated quality verdict over the produced output. */
  quality: QualityVerdict;
  /** The full execution log — recorded calls, workspace, produced text. */
  log: ExecutionLog;
}

export interface RunOptions {
  model: string;
  scoped?: boolean;
  /** Cap on tool-loop iterations per pass (default 15). */
  maxIterations?: number;
  /** Cap on the maximum auto-answer rounds (default 3). */
  maxAutoAnswers?: number;
  /** Output-token budget across the run; the executor trips the abort once the
   * recorded output tokens cross this (default 150_000). */
  outputTokenBudget?: number;
  /** The default source read/grep use when the coordinator names none. */
  source?: string;
  /** Injected for tests; defaults to the packaged instructions. */
  systemPrompt?: string;
  /** Injected for tests; defaults to the task for `scoped`. */
  task?: string;
  tools?: ToolDef[];
  /** Executor dependency overrides — injected for tests so no real model runs. */
  executorDeps?: ExecutorDeps;
  /** Injected for tests: resolve the coordinator model. */
  resolve?: typeof resolveCoordinator;
}

/**
 * Run one coordinator over the workload, un-stubbed. Warms the registry,
 * resolves the coordinator, then drives `chatWithToolLoop` with the real
 * executor — re-driving with the maximal answer when the coordinator pauses on a
 * scope question, to a cap. Aggregates cost and judges quality over the produced
 * output. Never throws — an unavailable coordinator yields a `RunResult` carrying
 * the reason with empty cost / quality.
 */
export async function runCoordination(opts: RunOptions): Promise<RunResult> {
  await warmRegistry();
  const scoped = opts.scoped ?? false;
  const resolve = opts.resolve ?? resolveCoordinator;
  const resolved = await resolve(opts.model);
  if ('unavailable' in resolved) {
    return {
      model: opts.model,
      scoped,
      unavailable: resolved.unavailable,
      passes: 0,
      iterations: 0,
      finalText: '',
      budgetTripped: false,
      cost: aggregateCost([], opts.model),
      quality: judgeQuality(''),
      log: emptyLog(),
    };
  }

  const log = emptyLog();
  const budget = opts.outputTokenBudget ?? 150_000;
  const controller = new AbortController();
  const baseExecutor = makeExecutor(log, { defaultSource: opts.source, ...opts.executorDeps });

  // The budget guard wraps the executor: after each real tool call it sums the
  // recorded output tokens and aborts once they cross the cap, so the loop stops
  // between iterations rather than running away.
  const executor: typeof baseExecutor = async (toolUse) => {
    const result = await baseExecutor(toolUse);
    const outSoFar = log.calls.reduce((sum, c) => sum + c.tokensOut, 0);
    if (outSoFar > budget) controller.abort(new Error(`output-token budget ${budget} exceeded`));
    return result;
  };

  const system = opts.systemPrompt ?? loadInstructions();
  const tools = opts.tools ?? COORDINATOR_TOOLS;
  const maxIterations = opts.maxIterations ?? 15;
  const maxAutoAnswers = opts.maxAutoAnswers ?? 3;

  const turns: Turn[] = [{ role: 'user', content: opts.task ?? taskFor(scoped) }];
  let passes = 0;
  let iterations = 0;
  let finalText = '';
  let budgetTripped = false;

  for (let round = 0; round <= maxAutoAnswers; round++) {
    let reply: ChatWithToolLoopResult;
    try {
      reply = await resolved.adapter.chatWithToolLoop!({
        systemPrompt: system,
        modelClass: resolved.modelClass,
        tools,
        turns,
        executor,
        maxIterations,
        abortSignal: controller.signal,
      });
    } catch (err) {
      // An aborted loop (budget) surfaces here; keep whatever was produced.
      budgetTripped = controller.signal.aborted;
      finalText = budgetTripped
        ? `(run stopped — ${String((controller.signal.reason as Error)?.message ?? 'aborted')})`
        : `(coordinator loop failed: ${String(err).slice(0, 160)})`;
      passes++;
      break;
    }

    passes++;
    iterations += reply.iterations;
    finalText = reply.text.trim();
    // The coordinator's OWN driving spend is the loop's aggregated usage — record
    // it under its concrete id so the breakdown separates coordinator spend from
    // the tiers it routed work to.
    log.calls.push({
      tool: '(coordinator loop)',
      model: reply.usage.model || resolved.modelId,
      tokensIn:
        reply.usage.inputTokens +
        reply.usage.cacheReadInputTokens +
        reply.usage.cacheCreationInputTokens,
      tokensOut: reply.usage.outputTokens,
      ms: 0,
    });

    if (controller.signal.aborted) {
      budgetTripped = true;
      break;
    }
    // A text-only reply that reads as a scope question gets the maximal answer
    // and one more pass; anything else is the final report.
    if (
      reply.toolUses.length === 0 &&
      round < maxAutoAnswers &&
      looksLikeScopeQuestion(finalText)
    ) {
      turns.push({ role: 'assistant', content: finalText });
      turns.push({ role: 'user', content: MOST_EXPANSIVE_ANSWER });
      continue;
    }
    break;
  }

  return {
    model: opts.model,
    modelId: resolved.modelId,
    provider: resolved.provider,
    scoped,
    passes,
    iterations,
    finalText,
    budgetTripped,
    cost: aggregateCost(log.calls, resolved.modelId),
    quality: judgeQuality(producedForGate(log)),
    log,
  };
}
