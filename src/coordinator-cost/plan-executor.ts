// STDIO-520 — the parallel half of the plan-first coordinator.
//
// The sequential `executePlan` walks the plan's nodes in dependency order, one at
// a time. This executor keeps that ordering guarantee but LAYERS the DAG and runs
// each layer's nodes CONCURRENTLY — the parallelism win: two capabilities that
// only depend on the same upstream run at the same time, so the run's wall-clock
// is the critical-path depth, not the node count.
//
// The layering is a PURE function of the plan (`dependsOn` edges only), so which
// nodes share a layer is deterministic and unit-testable without any network.
// Enactment is injected (`deps.enactNode`) — a real coordinator wraps
// `enactCapability`; tests pass a mock.

import type { ExecutionPlan, PlanNode } from '@verevoir/recipes/engine';
import type { RecordedCall } from './cost.js';

/** The outcome of running one plan node: its produced text, every model call it
 * made (for the cost rollup), and whether it failed. A failed run's dependents
 * can never satisfy their deps, so they are skipped. */
export interface NodeRun {
  /** The node's produced output — threaded into its dependents' directives. */
  text: string;
  /** Every model call this node made, for the whole-run cost aggregation. */
  calls: RecordedCall[];
  /** True when the node's enact errored or its gate failed. */
  failed?: boolean;
}

export interface PlanExecDeps {
  /** Run ONE node: enact its capability with a directive already threaded from
   * upstream results. Injected so the executor is testable without a network;
   * the coordinator provides the real one (a wrapper over `enactCapability`). */
  enactNode: (node: PlanNode, directive: string) => Promise<NodeRun>;
  /** Build a node's directive from the request and its upstream results (the
   * produced text of each capability in `node.dependsOn`). Optional — a sensible
   * default grounds the request with a labelled block per upstream. */
  buildDirective?: (node: PlanNode, request: string, upstream: Map<string, string>) => string;
}

export interface PlanExecResult {
  /** Capability type → produced text, for every node that ran (not the skipped). */
  results: Map<string, string>;
  /** All RecordedCalls across all nodes that ran, for the cost aggregation. */
  calls: RecordedCall[];
  /** The layers as executed; each is the capability types run CONCURRENTLY.
   * `layers.length` is the critical-path depth; the total size is the node
   * count. Order within a layer is stable (sorted by capability). */
  layers: string[][];
  /** Nodes that failed — their transitive dependents were skipped, so a failure
   * leaves a legible partial result rather than throwing. */
  failed: string[];
}

/** The default directive builder: the request, followed by one labelled grounding
 * block per upstream result, so a node sees what its prerequisites produced. */
function defaultBuildDirective(
  _node: PlanNode,
  request: string,
  upstream: Map<string, string>
): string {
  if (upstream.size === 0) return request;
  const grounding = [...upstream.entries()]
    .map(([capability, text]) => `grounding: ${capability}:\n${text}`)
    .join('\n\n');
  return `${request}\n\n${grounding}`;
}

/**
 * Layer the plan's DAG: layer 0 is the nodes with no in-plan dependency, and
 * layer k is the nodes whose every dependency sits in an earlier layer. PURE and
 * deterministic — membership follows only from `dependsOn`, and each layer is
 * sorted by capability so the order is stable across runs. A dependency naming a
 * capability not in the plan is treated as already-satisfied (it can't be waited
 * on). A cycle (which a well-formed plan never contains) leaves its nodes
 * unlayered rather than looping.
 */
export function layerPlan(plan: ExecutionPlan): PlanNode[][] {
  const inPlan = new Set(plan.nodes.map((n) => n.capability));
  const placed = new Set<string>();
  const layers: PlanNode[][] = [];

  while (placed.size < plan.nodes.length) {
    const ready = plan.nodes.filter(
      (n) => !placed.has(n.capability) && n.dependsOn.every((d) => !inPlan.has(d) || placed.has(d))
    );
    // No node became ready but some remain unplaced → a dependency cycle. Stop
    // rather than loop; the remaining nodes are left unlayered (never runnable).
    if (ready.length === 0) break;
    ready.sort((a, b) => a.capability.localeCompare(b.capability));
    for (const n of ready) placed.add(n.capability);
    layers.push(ready);
  }

  return layers;
}

/**
 * Execute a plan with its independent nodes running CONCURRENTLY. The DAG is
 * layered (`layerPlan`); each layer runs via `Promise.all`, and a barrier between
 * layers means a node never starts before its dependencies' results exist. Before
 * a node runs, its upstream results are gathered and threaded into its directive
 * (`deps.buildDirective`, or a labelled-grounding default).
 *
 * Failure is isolated: a node whose run reports `failed` — or whose `enactNode`
 * throws (caught, treated as failed) — is recorded in `failed`, and its
 * transitive dependents are SKIPPED (they can never satisfy their deps) while
 * independent nodes and layers proceed. This never throws: a failure yields a
 * legible partial result, not a dropped run.
 */
export async function executePlanParallel(
  plan: ExecutionPlan,
  deps: PlanExecDeps
): Promise<PlanExecResult> {
  const buildDirective = deps.buildDirective ?? defaultBuildDirective;
  const layers = layerPlan(plan);

  const results = new Map<string, string>();
  const calls: RecordedCall[] = [];
  const failed = new Set<string>();

  for (const layer of layers) {
    // A node is skipped when any dependency failed or was itself skipped — the
    // failure propagates transitively down the DAG, layer by layer.
    const runnable = layer.filter((n) => !n.dependsOn.some((d) => failed.has(d)));
    for (const n of layer) if (!runnable.includes(n)) failed.add(n.capability);

    const runs = await Promise.all(
      runnable.map(async (node): Promise<[PlanNode, NodeRun]> => {
        const upstream = new Map<string, string>();
        for (const dep of node.dependsOn) {
          const text = results.get(dep);
          if (text !== undefined) upstream.set(dep, text);
        }
        const directive = buildDirective(node, plan.request, upstream);
        try {
          return [node, await deps.enactNode(node, directive)];
        } catch (err) {
          const message = `<enact ${node.capability} failed: ${String(err).slice(0, 200)}>`;
          return [node, { text: message, calls: [], failed: true }];
        }
      })
    );

    for (const [node, run] of runs) {
      calls.push(...run.calls);
      if (run.failed) failed.add(node.capability);
      else results.set(node.capability, run.text);
    }
  }

  return {
    results,
    calls,
    layers: layers.map((layer) => layer.map((n) => n.capability)),
    failed: [...failed],
  };
}
