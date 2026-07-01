import { describe, it, expect } from 'vitest';
import type { ExecutionPlan, PlanNode } from '@verevoir/recipes/engine';
import { gatePlan, parseEntrySelection } from '../src/coordinator-cost/plan-coordinator.js';

// Pure logic only — the gate's sanity checks and the entry-selection parse. The
// reasoning-tier selection call and the real node enactment are network and are
// not unit-tested (the executor's layering has its own suite).

const node = (
  capability: string,
  dependsOn: string[] = [],
  source: 'retrieved' | 'composed' = 'composed'
): PlanNode => ({ capability, practices: [], dependsOn, source });

const plan = (entry: string[], nodes: PlanNode[]): ExecutionPlan => ({
  request: 'a request',
  entry,
  nodes,
});

describe('gatePlan — inspect a plan before spending on it', () => {
  it('passes a non-empty, acyclic plan whose entries and deps all resolve', () => {
    const p = plan(
      ['build-widget'],
      [node('find-parts'), node('build-widget', ['find-parts'], 'retrieved')]
    );
    expect(gatePlan(p)).toEqual({ ok: true, findings: [] });
  });

  it('fails an empty plan — there is nothing to execute', () => {
    const verdict = gatePlan(plan([], []));
    expect(verdict.ok).toBe(false);
    expect(verdict.findings).toContain('plan is empty — no capabilities to execute');
  });

  it('fails when an entry capability has no node in the plan', () => {
    const p = plan(['missing-entry'], [node('some-other-node')]);
    const verdict = gatePlan(p);
    expect(verdict.ok).toBe(false);
    expect(verdict.findings).toContain('entry capability "missing-entry" has no node in the plan');
  });

  it('fails when a node depends on a capability the plan does not contain', () => {
    const p = plan(['build-widget'], [node('build-widget', ['find-parts'], 'retrieved')]);
    const verdict = gatePlan(p);
    expect(verdict.ok).toBe(false);
    expect(verdict.findings).toContain(
      'node "build-widget" depends on missing capability "find-parts"'
    );
  });

  it('fails when the dependency edges form a cycle', () => {
    const p = plan(['a'], [node('a', ['b'], 'retrieved'), node('b', ['a'])]);
    const verdict = gatePlan(p);
    expect(verdict.ok).toBe(false);
    expect(verdict.findings).toContain(
      'plan has a dependency cycle — it cannot be topologically ordered'
    );
  });

  it('reports every failing check at once rather than stopping at the first', () => {
    const p = plan(['missing-entry'], [node('orphan', ['also-missing'])]);
    const verdict = gatePlan(p);
    expect(verdict.findings).toEqual(
      expect.arrayContaining([
        'entry capability "missing-entry" has no node in the plan',
        'node "orphan" depends on missing capability "also-missing"',
      ])
    );
  });
});

describe('parseEntrySelection — read selected ids out of a model reply', () => {
  const ids = ['build-widget', 'find-parts', 'paint-widget'];

  it('picks the ids the reply names, in corpus order', () => {
    const reply = '- paint-widget\n- build-widget';
    expect(parseEntrySelection(reply, ids)).toEqual(['build-widget', 'paint-widget']);
  });

  it('ignores ids the corpus does not contain', () => {
    expect(parseEntrySelection('- build-widget\n- imaginary-cap', ids)).toEqual(['build-widget']);
  });

  it('does not fire a shorter id on a longer id that contains it', () => {
    // 'build-widget' must not be selected merely because 'rebuild-widgets'
    // appears — the match is word-boundary anchored.
    expect(parseEntrySelection('- rebuild-widgets', ids)).toEqual([]);
  });

  it('returns nothing when the reply names no known id', () => {
    expect(parseEntrySelection('I could not find a match.', ids)).toEqual([]);
  });
});
