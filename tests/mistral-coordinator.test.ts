import { describe, it, expect } from 'vitest';
import { classify, type RoutingStep } from '../src/mistral-coordinator/verdict.js';

// The verdict classification only — the model calls are network and are not
// unit-tested. These pin the three inverted-tier questions over synthetic
// traces: reasoning escalated up to opus, token production enacted, README
// snippet delegated down to haiku — and the "coordinates" conjunction.

const step = (partial: Partial<RoutingStep> & { tool: string }): RoutingStep => ({
  step: 1,
  model: '(default)',
  argsSummary: '',
  ...partial,
});

/** A fully-correct inverted-tier trace: decision up to opus, production enacted,
 * snippet down to haiku. */
const coordinatedTrace: RoutingStep[] = [
  step({ step: 1, tool: 'delegate', model: 'opus', argsSummary: 'decide token architecture' }),
  step({ step: 2, tool: 'enact_capability', model: '(default)', argsSummary: 'DTCG token set' }),
  step({ step: 3, tool: 'delegate', model: 'haiku', argsSummary: 'README snippet' }),
];

describe('classify — the three inverted-tier questions', () => {
  it('escalates reasoning when a routing tool carries model:opus', () => {
    expect(classify([step({ tool: 'delegate', model: 'opus' })])).toMatchObject({
      escalatedReasoning: true,
    });
  });

  it('escalates reasoning via dispatch to opus, not only delegate', () => {
    expect(classify([step({ tool: 'dispatch', model: 'opus' })])).toMatchObject({
      escalatedReasoning: true,
    });
  });

  it('reads a concrete opus id as the opus tier', () => {
    expect(classify([step({ tool: 'delegate', model: 'claude-opus-4' })])).toMatchObject({
      escalatedReasoning: true,
    });
  });

  it('does not count opus named on a non-routing tool as escalation', () => {
    expect(classify([step({ tool: 'write_file', model: 'opus' })])).toMatchObject({
      escalatedReasoning: false,
    });
  });

  it('marks enacted-capability when enact_capability is called', () => {
    expect(classify([step({ tool: 'enact_capability' })])).toMatchObject({
      enactedCapability: true,
    });
  });

  it('does not mark enacted-capability when the production is delegated instead', () => {
    expect(classify([step({ tool: 'delegate', model: 'haiku' })])).toMatchObject({
      enactedCapability: false,
    });
  });

  it('delegates light work down when a routing tool carries model:haiku', () => {
    expect(classify([step({ tool: 'dispatch', model: 'haiku' })])).toMatchObject({
      delegatedLightDown: true,
    });
  });

  it('does not count a default-tier delegate as delegating down', () => {
    expect(classify([step({ tool: 'delegate', model: '(default)' })])).toMatchObject({
      delegatedLightDown: false,
    });
  });
});

describe('classify — the overall coordinates tag', () => {
  it('coordinates when all three routes are right', () => {
    expect(classify(coordinatedTrace)).toMatchObject({
      escalatedReasoning: true,
      enactedCapability: true,
      delegatedLightDown: true,
      coordinates: true,
    });
  });

  it('does not coordinate when the reasoning was not escalated up', () => {
    const noEscalation = coordinatedTrace.filter((s) => s.model !== 'opus');
    expect(classify(noEscalation).coordinates).toBe(false);
  });

  it('does not coordinate when the production was not enacted', () => {
    const noEnact = coordinatedTrace.filter((s) => s.tool !== 'enact_capability');
    expect(classify(noEnact).coordinates).toBe(false);
  });

  it('does not coordinate when the light work was not pushed down', () => {
    const noHaiku = coordinatedTrace.filter((s) => s.model !== 'haiku');
    expect(classify(noHaiku).coordinates).toBe(false);
  });

  it('does not coordinate on an empty trace', () => {
    expect(classify([]).coordinates).toBe(false);
  });
});
