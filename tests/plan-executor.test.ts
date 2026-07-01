import { describe, it, expect } from 'vitest';
import type { ExecutionPlan, PlanNode } from '@verevoir/recipes/engine';
import {
  layerPlan,
  executePlanParallel,
  type NodeRun,
  type PlanExecDeps,
} from '../src/coordinator-cost/plan-executor.js';
import type { RecordedCall } from '../src/coordinator-cost/cost.js';

// The parallel executor's layering + threading + failure isolation are all pure
// of the network — enactNode is injected. These pin the DAG diamond a → [b,c] → d
// (b and c both build on a; d builds on both): its layering, its concurrency (b
// and c overlap), its result threading, cost aggregation, and failure isolation.

const node = (
  capability: string,
  dependsOn: string[] = [],
  source: PlanNode['source'] = 'composed'
): PlanNode => ({ capability, practices: [], dependsOn, source });

// The diamond: a with no deps, b and c on a, d on b and c.
const diamond: ExecutionPlan = {
  request: 'do the thing',
  entry: ['d'],
  nodes: [
    node('a', [], 'composed'),
    node('b', ['a']),
    node('c', ['a']),
    node('d', ['b', 'c'], 'retrieved'),
  ],
};

const call = (tool: string, model: string): RecordedCall => ({
  tool,
  model,
  tokensIn: 1,
  tokensOut: 1,
  ms: 1,
});

/** A run that produces `<cap> output` and records one call under a per-cap model,
 * so the cost aggregation can be checked per node. */
const producedBy = (capability: string): NodeRun => ({
  text: `${capability} output`,
  calls: [call('enact_capability', `model-${capability}`)],
});

describe('layerPlan — layers the DAG deterministically from dependsOn alone', () => {
  it('puts independent nodes in the same layer and dependents after them', () => {
    const layers = layerPlan(diamond).map((l) => l.map((n) => n.capability));
    expect(layers).toEqual([['a'], ['b', 'c'], ['d']]);
  });

  it('orders a layer by capability so the layering is stable across runs', () => {
    // c declared before b, but the layer is sorted → b before c.
    const plan: ExecutionPlan = {
      request: 'r',
      entry: [],
      nodes: [node('a'), node('c', ['a']), node('b', ['a'])],
    };
    expect(layerPlan(plan).map((l) => l.map((n) => n.capability))).toEqual([['a'], ['b', 'c']]);
  });

  it('treats a dependency not in the plan as already satisfied', () => {
    const plan: ExecutionPlan = {
      request: 'r',
      entry: [],
      nodes: [node('b', ['not-in-plan'])],
    };
    // b's only dep is out-of-plan, so b is layer 0.
    expect(layerPlan(plan).map((l) => l.map((n) => n.capability))).toEqual([['b']]);
  });
});

describe('executePlanParallel — layers, threads, aggregates, isolates failure', () => {
  it('reports the executed layers as the critical-path decomposition', async () => {
    const deps: PlanExecDeps = { enactNode: async (n) => producedBy(n.capability) };
    const result = await executePlanParallel(diamond, deps);
    expect(result.layers).toEqual([['a'], ['b', 'c'], ['d']]);
  });

  it('runs same-layer nodes concurrently — b and c both start before either finishes', async () => {
    const started: string[] = [];
    // Each of b and c blocks on a barrier that only resolves once BOTH have
    // started. If the executor ran the layer sequentially, the first would block
    // forever and the run would time out — so the test passing proves overlap.
    let arrived = 0;
    let openBarrier!: () => void;
    const barrier = new Promise<void>((r) => (openBarrier = r));

    const deps: PlanExecDeps = {
      enactNode: async (n) => {
        started.push(n.capability);
        if (n.capability === 'b' || n.capability === 'c') {
          arrived += 1;
          if (arrived === 2) openBarrier();
          await barrier;
        }
        return producedBy(n.capability);
      },
    };

    const result = await executePlanParallel(diamond, deps);
    expect(started.slice(0, 3)).toEqual(['a', 'b', 'c']); // a first, then b+c together
    expect(result.results.get('d')).toBe('d output'); // d still got its inputs
  });

  it("threads each upstream's produced text into a node's directive", async () => {
    const directives = new Map<string, string>();
    const deps: PlanExecDeps = {
      enactNode: async (n, directive) => {
        directives.set(n.capability, directive);
        return producedBy(n.capability);
      },
    };
    await executePlanParallel(diamond, deps);

    const dDirective = directives.get('d')!;
    expect(dDirective).toContain('do the thing'); // the request
    expect(dDirective).toContain('b output'); // b threaded in
    expect(dDirective).toContain('c output'); // c threaded in
    // a, with no upstream, sees just the request.
    expect(directives.get('a')).toBe('do the thing');
  });

  it('aggregates every ran node’s recorded calls across all layers', async () => {
    const deps: PlanExecDeps = { enactNode: async (n) => producedBy(n.capability) };
    const result = await executePlanParallel(diamond, deps);
    expect(result.calls.map((c) => c.model).sort()).toEqual([
      'model-a',
      'model-b',
      'model-c',
      'model-d',
    ]);
  });

  it('skips a failed node’s transitive dependents while independent nodes still run', async () => {
    const deps: PlanExecDeps = {
      enactNode: async (n) =>
        n.capability === 'b'
          ? { text: 'b broke', calls: [call('enact_capability', 'model-b')], failed: true }
          : producedBy(n.capability),
    };
    const result = await executePlanParallel(diamond, deps);

    // b failed → d (which depends on b) is skipped; c (independent of b) still ran.
    expect(result.failed.sort()).toEqual(['b', 'd']);
    expect(result.results.has('d')).toBe(false);
    expect(result.results.get('c')).toBe('c output');
    // the failed node's own calls are still aggregated (real spend).
    expect(result.calls.some((c) => c.model === 'model-b')).toBe(true);
  });

  it('treats a thrown enactNode as a failed node rather than throwing out', async () => {
    const deps: PlanExecDeps = {
      enactNode: async (n) => {
        if (n.capability === 'b') throw new Error('boom');
        return producedBy(n.capability);
      },
    };
    const result = await executePlanParallel(diamond, deps);
    expect(result.failed.sort()).toEqual(['b', 'd']);
    expect(result.results.get('c')).toBe('c output');
  });
});
