// STDIO-519 — Mistral-coordinator harness: the runner.
//
// Drives one model (mistral by default) through a multi-turn tool loop with
// `chatWithToolLoop`: the packaged instructions as the system prompt, the
// coordination task as the user turn, the coordinator toolset available. The
// executor RECORDS each tool call into an ordered trace and returns a short,
// plausible STUB — it runs NO real pipeline. This is v1: cheap, and about the
// routing JUDGEMENT over the sequence, not the downstream work.
//
// Model selection mirrors the STDIO-517 eval: `chatWithToolLoop` takes no
// model-id field — `modelClass` selects the concrete model, and a term
// ("mistral", "opus") resolves through `resolveModelByTerm` to a
// `{ provider, modelClass }`. We import THAT provider's adapter and pass its
// class, exactly how dispatch drives a model.

import type {
  ChatWithToolLoopOptions,
  ChatWithToolLoopResult,
  ModelClass,
  ToolDef,
  ToolUse,
} from '@verevoir/llm';
import { resolveModelByTerm } from '@verevoir/llm';
import { warmRegistry, importProviderAdapter } from '../registry.js';
import { loadInstructions } from '../instructions.js';
import { COORDINATOR_TOOLS } from './tools.js';
import { COORDINATION_TASK } from './task.js';
import type { RoutingStep } from './verdict.js';

/** The adapter surface the runner drives. `chatWithToolLoop` is optional so an
 * adapter without it is a legible status, never a crash. */
interface ToolLoopAdapter {
  chatWithToolLoop?: (options: ChatWithToolLoopOptions) => Promise<ChatWithToolLoopResult>;
}

/** A resolved, driveable model: the adapter, its class, and the concrete id
 * (reporting only). */
interface ResolvedModel {
  provider: string;
  modelClass: ModelClass;
  modelId: string;
  adapter: ToolLoopAdapter;
}

/** Resolve a term to a tool-loop-capable model, or a reason it can't be driven.
 * Never throws — an unconfigured / unknown / loop-less model is a status. */
export async function resolveModel(term: string): Promise<ResolvedModel | { unavailable: string }> {
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

/** A short digest of a tool call's arguments, for the trace — the first present
 * of a few well-known fields, truncated. Keeps the report legible without
 * dumping full payloads. */
function summariseArgs(input: Record<string, unknown>): string {
  const pick = (input.directive ?? input.capability ?? input.prompt ?? input.path ?? '') as unknown;
  const text = typeof pick === 'string' ? pick : JSON.stringify(pick);
  const trimmed = text.replace(/\s+/g, ' ').trim();
  return trimmed.length > 80 ? `${trimmed.slice(0, 77)}…` : trimmed || '(no args)';
}

/** The stub the executor returns for a tool call, so the loop proceeds without
 * running any real pipeline. The stub reflects what the tier WOULD have
 * produced, so the coordinator's report reads coherently. */
export function stubResult(toolUse: ToolUse): string {
  const model = tier(toolUse.input.model);
  switch (toolUse.name) {
    case 'enact_capability':
      return '<enacted: DTCG token set produced, gate passed>';
    case 'delegate':
    case 'dispatch':
      if (model === 'opus') return '<opus returned the architecture decision>';
      if (model === 'haiku') return '<haiku produced the snippet>';
      return '<worker returned its result>';
    case 'read_file':
    case 'write_file':
      return '<ok>';
    default:
      return '<ok>';
  }
}

/** The model override as a bare tier term, or empty when none was named. */
function tier(model: unknown): string {
  return typeof model === 'string' ? model.toLowerCase() : '';
}

/** What one coordination run produced. */
export interface RunResult {
  model: string;
  modelId?: string;
  provider?: string;
  /** Set when the model couldn't be driven at all; then `trace` is empty. */
  unavailable?: string;
  /** The ordered routing trace the executor recorded. */
  trace: RoutingStep[];
  /** The coordinator's final text after the loop. */
  finalText: string;
  /** How many model calls the loop made. */
  iterations: number;
  /** Aggregated token usage across the loop. */
  usage?: ChatWithToolLoopResult['usage'];
}

export interface RunOptions {
  /** The coordinator model term (default `mistral`). */
  model: string;
  /** Cap on tool-loop iterations (default 10). */
  maxIterations?: number;
  /** Injected for tests; defaults to the packaged instructions. */
  systemPrompt?: string;
  /** Injected for tests; defaults to the coordination task. */
  task?: string;
  tools?: ToolDef[];
}

/**
 * Run one coordination pass. Warms the registry, resolves the model, then drives
 * `chatWithToolLoop` with a recording executor. Never throws — an unavailable
 * model yields a `RunResult` carrying the reason and an empty trace.
 */
export async function runCoordination(opts: RunOptions): Promise<RunResult> {
  await warmRegistry();
  const resolved = await resolveModel(opts.model);
  if ('unavailable' in resolved) {
    return {
      model: opts.model,
      unavailable: resolved.unavailable,
      trace: [],
      finalText: '',
      iterations: 0,
    };
  }

  const trace: RoutingStep[] = [];
  const executor = async (toolUse: ToolUse): Promise<string> => {
    trace.push({
      step: trace.length + 1,
      tool: toolUse.name,
      model: typeof toolUse.input.model === 'string' ? toolUse.input.model : '(default)',
      argsSummary: summariseArgs(toolUse.input),
    });
    return stubResult(toolUse);
  };

  const reply = await resolved.adapter.chatWithToolLoop!({
    systemPrompt: opts.systemPrompt ?? loadInstructions(),
    modelClass: resolved.modelClass,
    tools: opts.tools ?? COORDINATOR_TOOLS,
    turns: [{ role: 'user', content: opts.task ?? COORDINATION_TASK }],
    executor,
    maxIterations: opts.maxIterations ?? 10,
  });

  return {
    model: opts.model,
    modelId: resolved.modelId,
    provider: resolved.provider,
    trace,
    finalText: reply.text.trim(),
    iterations: reply.iterations,
    usage: reply.usage,
  };
}
