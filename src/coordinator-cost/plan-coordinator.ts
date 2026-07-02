// STDIO-520 — the PLAN-FIRST coordinator.
//
// The sibling STDIO-521 harness (run.ts) drives a coordinator that IMPROVISES a
// tool loop turn by turn — non-deterministic, serial, and expensive because the
// whole context is re-sent every turn. This is the other arm of the comparison:
// instead of improvising, we PLAN a capability DAG up front, GATE it (inspect
// before we spend), EXECUTE it deterministically and in parallel, then MEASURE
// the same way — so a reader can put plan-first's cost + parallel structure next
// to the tool-loop run on the same task.
//
// Most of the plan is already authored: the capability tree's `composes` edges
// give the DAG for free (buildPlanGraph, from @verevoir/recipes). We complete it
// with the run's one intrinsic bit — which entry capabilities the request calls
// for (selectEntryTypes, one reasoning-tier call) — and the plan is disposable,
// kept only for the run.
//
// Node execution reuses enact_capability (governed + verified worker production)
// and mirrors executor.ts's usage-capture: enact's internal `delegate` is wrapped
// so each node's worker + reviewer token usage lands in real RecordedCalls, not
// estimates. The parallel executor (plan-executor.ts) drives the layers.

import type { ModelClass, PerModelUsage } from '@verevoir/llm';
import { sumUsages } from '@verevoir/llm';
import type { CapabilityDescriptor } from '@verevoir/recipes';
import {
  buildExecutionPlan,
  executePlanParallel,
  gatePlan,
  parseEntrySelection,
  type ExecutionPlan,
  type GateVerdict,
  type NodeRun,
  type PlanExecDeps,
  type PlanExecResult,
  type PlanNode,
} from '@verevoir/recipes/engine';
import { enactCapability } from '../tools/enact.js';
import { delegateDetailed, type WorkerCall, type delegate } from '../tools/delegate.js';
import { loadCapabilityCorpus } from '../tools/provision.js';
import { tierChat } from '../tiers.js';
import { resolveCoordinator } from './run.js';
import { aggregateCost, type CostBreakdown, type RecordedCall } from './cost.js';
import { judgeQuality, type QualityVerdict } from './quality.js';
import { taskFor } from './task.js';

/** A text-returning `delegate` — the signature enact injects; shared parameter
 * list with `delegateDetailed`, so the harness wraps one as the other. */
type Delegate = typeof delegate;

/** Sum a WorkerCall's per-model usages into a single rollup, preferring the
 * per-call `usages` (worker attempts + reviewer) over the single `usage`.
 * Mirrors executor.ts — the plan coordinator captures node cost the same way. */
function rollup(call: WorkerCall): PerModelUsage {
  const rounds = call.usages ?? (call.usage ? [call.usage] : []);
  return rounds.length ? sumUsages(rounds) : {};
}

/** Turn a per-model usage rollup into RecordedCalls — one per model that ran, so
 * a node that spent on both a worker and a reviewer shows both tiers. An empty
 * rollup yields a single zero-token line under `(worker)`, so the node still
 * appears in the trace. */
function recordedCallsFor(usage: PerModelUsage, tool: string, ms: number): RecordedCall[] {
  const entries = Object.entries(usage);
  if (entries.length === 0) {
    return [{ tool, model: '(worker)', tokensIn: 0, tokensOut: 0, ms }];
  }
  return entries.map(([model, u]) => ({
    tool,
    model,
    tokensIn: u.in,
    tokensOut: u.out,
    cacheRead: u.cacheRead ?? 0,
    cacheWrite: u.cacheWrite ?? 0,
    ms,
  }));
}

/**
 * Enact one plan node, capturing its real per-model cost. Wraps enact's internal
 * delegate so the worker + reviewer usage is captured into RecordedCalls, exactly
 * as executor.ts does for the tool-loop harness — so a node's `NodeRun.calls` are
 * the tokens that actually ran, not an estimate. Never throws: a failing enact
 * returns its own legible message as the node's text and is marked `failed`.
 *
 * `enactFn` is injected for tests so no real model runs.
 */
export async function enactNode(
  node: PlanNode,
  directive: string,
  enactFn: typeof enactCapability = enactCapability,
  delegateFn: typeof delegateDetailed = delegateDetailed
): Promise<NodeRun> {
  const captured: PerModelUsage[] = [];
  const capturingDelegate: Delegate = async (di, provision, tier, makeReviewer) => {
    const call = await delegateFn(di, provision, tier, makeReviewer);
    const u = rollup(call);
    if (Object.keys(u).length) captured.push(u);
    return call.text;
  };

  const startedAt = Date.now();
  let text: string;
  let failed = false;
  try {
    text = await enactFn({ capability: node.capability, directive }, capturingDelegate);
  } catch (err) {
    text = `<enact ${node.capability} failed: ${String(err).slice(0, 160)}>`;
    failed = true;
  }
  const ms = Date.now() - startedAt;
  const usage = captured.length ? sumUsages(captured) : {};
  return {
    text,
    calls: recordedCallsFor(usage, `enact:${node.capability}`, ms),
    failed,
  };
}

/** System prompt for the entry-selection call — a leaner sibling of recipes'
 * NARROW_SYSTEM_PROMPT: no high-recall retrieval step here, so the model sees the
 * WHOLE corpus's entry types and picks the ones the request genuinely calls for.
 * Prerequisites are pulled in by buildPlanGraph, so it must not list those. */
export const SELECT_ENTRY_SYSTEM_PROMPT = `You are routing a request to the capabilities that will fulfil it. You are given a request and a LIST of capabilities, each with an id and what it produces. Pick the capabilities the request GENUINELY calls for.

Rules:
- A single request often calls for several capabilities — select every one the request actually asks for, in substance.
- Do NOT select a capability merely because it is adjacent or could conceivably relate. If the request does not ask for what a capability produces, leave it out.
- Prerequisites are added automatically downstream — select only the capabilities the request directly asks for, not the steps they depend on.
- Use the capability ids exactly as written in the list.

Reply with ONLY the selected ids, one per line, each prefixed with "- ". No commentary.`;

/** A reasoning-tier chat call: request + the corpus's capability menu → the entry
 * ids the request calls for. */
export type SelectChat = (opts: {
  systemPrompt: string;
  turns: { role: 'user'; content: string }[];
  modelClass?: ModelClass;
}) => Promise<{ content: string }>;

/**
 * Pick the entry capability type(s) the request calls for — the plan's one
 * intrinsic bit (the DAG below them is authored in `composes`). A single
 * reasoning-tier call given the request and every capability's id + description
 * returns the entry ids. Deterministic where the adapter allows (temperature is
 * the adapter's default; we hold the prompt + corpus fixed). Never throws — a
 * failed or unresolvable call returns `[]`, which the gate then rejects legibly.
 *
 * `chat` is injected for tests so no real model runs.
 */
export async function selectEntryTypes(
  request: string,
  corpus: CapabilityDescriptor[],
  coordinatorModelClass: ModelClass = 'reasoning',
  chat?: SelectChat
): Promise<string[]> {
  const ids = corpus.map((c) => c.type);
  if (ids.length === 0) return [];

  const resolvedChat = chat ?? (await resolveSelectChat(coordinatorModelClass));
  if (!resolvedChat) return [];

  const menu = corpus
    .map((c) => `- ${c.type}: ${c.description ?? c.postcondition ?? ''}`)
    .join('\n');
  const res = await resolvedChat({
    systemPrompt: SELECT_ENTRY_SYSTEM_PROMPT,
    turns: [
      {
        role: 'user',
        content:
          `REQUEST:\n${request}\n\n` +
          `CAPABILITIES:\n${menu}\n\n` +
          `Select the capabilities this request directly calls for.`,
      },
    ],
    modelClass: coordinatorModelClass,
  }).catch(() => null);

  return res ? parseEntrySelection(res.content, ids) : [];
}

/** Resolve the reasoning tier to a chat fn for entry selection, or null when no
 * provider serves it (then selection returns `[]` and the gate reports it). */
async function resolveSelectChat(modelClass: ModelClass): Promise<SelectChat | null> {
  const tier = await tierChat(modelClass).catch(() => null);
  if (!tier) return null;
  return (opts) => tier.chat(opts);
}

export interface PlanFirstOptions {
  model: string;
  scoped?: boolean;
  /** Injected for tests; defaults to the task for `scoped`. */
  task?: string;
  /** Injected for tests: resolve the coordinator model. */
  resolve?: typeof resolveCoordinator;
  /** Injected for tests: load the capability corpus. */
  loadCorpus?: typeof loadCapabilityCorpus;
  /** Injected for tests: pick the entry capabilities. */
  selectEntry?: (request: string, corpus: CapabilityDescriptor[]) => Promise<string[]>;
  /** Injected for tests: the parallel executor. */
  executePlan?: typeof executePlanParallel;
  /** Injected for tests: enact one node. */
  enactNodeFn?: (node: PlanNode, directive: string) => Promise<NodeRun>;
}

export interface PlanFirstResult {
  model: string;
  modelId?: string;
  provider?: string;
  scoped: boolean;
  /** Set when the coordinator couldn't be driven, or the plan was gated out. */
  aborted?: string;
  /** The disposable plan — the DAG, kept only for this run. */
  plan: ExecutionPlan;
  /** The gate verdict over the plan (the inspect-before-you-spend control). */
  gate: GateVerdict;
  /** The execution layers — each inner array runs in parallel; the outer order
   * is the dependency order. Empty when the run aborted before execution. */
  layers: string[][];
  /** Each node's produced text, keyed by capability. */
  results: Map<string, string>;
  /** Nodes whose enact failed. */
  failed: string[];
  /** The per-tier cost breakdown across every node's recorded calls. */
  cost: CostBreakdown;
  /** The gated quality verdict over the produced output. */
  quality: QualityVerdict;
  /** Wall-clock for the whole plan-first run, ms. */
  wallClockMs: number;
}

/** The directive a node is enacted with: the run's request, a note when the node
 * is a pulled-in prerequisite, then one labelled grounding block per upstream
 * result — so a node sees both what it's for and what its prerequisites produced.
 * Matches the executor's `buildDirective` signature (the executor threads the
 * upstream map). */
function directiveFor(node: PlanNode, request: string, upstream: Map<string, string>): string {
  const head =
    node.source === 'retrieved'
      ? request
      : `${request}\n\n(You are producing the "${node.capability}" prerequisite this work composes.)`;
  if (upstream.size === 0) return head;
  const grounding = [...upstream.entries()]
    .map(([capability, text]) => `grounding: ${capability}:\n${text}`)
    .join('\n\n');
  return `${head}\n\n${grounding}`;
}

/**
 * Run one coordinator plan-first over the workload: resolve the coordinator, load
 * the corpus, select the entry capabilities, build + GATE the plan, then execute
 * it in parallel and measure. Never throws — an unavailable coordinator or a
 * gated-out plan yields a `PlanFirstResult` carrying the reason with an empty
 * execution, so the two coordinator arms report symmetrically.
 *
 * The gate is the load-bearing difference from the tool loop: the plan is
 * inspected as a whole BEFORE any worker spends, so a malformed plan is aborted
 * legibly rather than discovered mid-run.
 */
export async function planFirstCoordination(opts: PlanFirstOptions): Promise<PlanFirstResult> {
  const startedAt = Date.now();
  const scoped = opts.scoped ?? false;
  const request = opts.task ?? taskFor(scoped);
  const resolve = opts.resolve ?? resolveCoordinator;
  const loadCorpus = opts.loadCorpus ?? loadCapabilityCorpus;
  const executePlan = opts.executePlan ?? executePlanParallel;

  const emptyPlan: ExecutionPlan = { request, entry: [], nodes: [] };
  const abort = (reason: string, plan = emptyPlan, gate?: GateVerdict): PlanFirstResult => ({
    model: opts.model,
    scoped,
    aborted: reason,
    plan,
    gate: gate ?? { ok: false, findings: [reason] },
    layers: [],
    results: new Map(),
    failed: [],
    cost: aggregateCost([], opts.model),
    quality: judgeQuality(''),
    wallClockMs: Date.now() - startedAt,
  });

  const resolved = await resolve(opts.model);
  if ('unavailable' in resolved) return abort(resolved.unavailable);

  const corpus = await loadCorpus().catch(() => [] as CapabilityDescriptor[]);
  if (corpus.length === 0) {
    return abort('could not load the capability corpus — check the guardrails source');
  }

  // Planning is the ONE smart step — plan-first's whole point is plan-smart /
  // execute-cheap. So entry selection runs on the REASONING tier regardless of
  // which model is nominally "coordinating" (a cheap coordinator like mistral
  // can't plan, but it doesn't need to — it just drives the deterministic
  // execution the reasoning-tier plan hands it).
  const selectEntry =
    opts.selectEntry ??
    ((req: string, corp: CapabilityDescriptor[]) => selectEntryTypes(req, corp, 'reasoning'));
  const entry = await selectEntry(request, corpus).catch(() => [] as string[]);
  if (entry.length === 0) {
    return abort('no entry capability selected for the request');
  }

  const plan = buildExecutionPlan(request, entry, corpus);
  const gate = gatePlan(plan);
  if (!gate.ok) {
    return {
      ...abort(`plan gated out: ${gate.findings.join('; ')}`, plan, gate),
      modelId: resolved.modelId,
      provider: resolved.provider,
    };
  }

  const enactOne = opts.enactNodeFn ?? ((node, directive) => enactNode(node, directive));
  const deps: PlanExecDeps = {
    enactNode: (node, directive) => enactOne(node, directive),
    buildDirective: directiveFor,
  };
  const exec: PlanExecResult = await executePlan(plan, deps);

  return {
    model: opts.model,
    modelId: resolved.modelId,
    provider: resolved.provider,
    scoped,
    plan,
    gate,
    layers: exec.layers,
    results: exec.results,
    failed: exec.failed,
    cost: aggregateCost(exec.calls, resolved.modelId),
    quality: judgeQuality([...exec.results.values()].join('\n\n')),
    wallClockMs: Date.now() - startedAt,
  };
}
