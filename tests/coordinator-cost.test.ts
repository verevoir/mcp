import { describe, it, expect } from 'vitest';
import { warmRegistry } from '../src/registry.js';
import { roleOf, aggregateCost, type RecordedCall } from '../src/coordinator-cost/cost.js';
import { collectTokens, buildChecklist, judgeQuality } from '../src/coordinator-cost/quality.js';

// Pure logic only — the executor's real tool calls are network and are not
// unit-tested. These pin the cost aggregation (tiers, sums, skips) and the
// quality checklist (dimensions, alias layer) that the harness reports.

const call = (tool: string, model: string, tokensIn = 0, tokensOut = 0): RecordedCall => ({
  tool,
  model,
  tokensIn,
  tokensOut,
  ms: 1,
});

describe('roleOf — a call maps to the tier it played', () => {
  const COORD = 'mistral-small-latest';

  it('tags the coordinator when the model is the driving model', () => {
    expect(roleOf(call('delegate', COORD), COORD)).toBe('coordinator');
  });

  it('tags reasoning when a routing tool escalated to opus', () => {
    expect(roleOf(call('delegate', 'claude-opus-4-8'), COORD)).toBe('reasoning');
  });

  it('tags light when a routing tool went down to haiku', () => {
    expect(roleOf(call('delegate', 'claude-haiku-4-5'), COORD)).toBe('light');
  });

  it('tags worker for an enact/delegate on some other tier', () => {
    expect(roleOf(call('enact_capability', 'DeepSeek-V3.2'), COORD)).toBe('worker');
  });

  it('tags other for a non-routing call on an unrelated model', () => {
    expect(roleOf(call('read_file', 'something-else'), COORD)).toBe('other');
  });
});

describe('aggregateCost — rolls recorded calls into a per-tier breakdown', () => {
  const COORD = 'mistral-small-latest';

  it('sums tokens per model, skips inline (none) calls, and totals the run', () => {
    const calls = [
      call('delegate', 'claude-opus-4-8', 100, 50),
      call('enact_capability', 'DeepSeek-V3.2', 200, 100),
      call('enact_capability', 'DeepSeek-V3.2', 40, 10),
      call('read_file', '(none)'), // inline — contributes nothing
    ];
    const b = aggregateCost(calls, COORD);

    // '(none)' excluded → only the two real models appear.
    expect(b.perModel.map((m) => m.model).sort()).toEqual(['DeepSeek-V3.2', 'claude-opus-4-8']);
    // DeepSeek's two calls summed into one line.
    const deepseek = b.perModel.find((m) => m.model === 'DeepSeek-V3.2');
    expect(deepseek).toMatchObject({ tokensIn: 240, tokensOut: 110, calls: 2, role: 'worker' });
    // opus tagged reasoning, one call.
    expect(b.perModel.find((m) => m.model === 'claude-opus-4-8')).toMatchObject({
      role: 'reasoning',
      calls: 1,
    });
    // totals span every real model, none double-counted.
    expect(b.totalTokensIn).toBe(340);
    expect(b.totalTokensOut).toBe(160);
  });

  it('orders the breakdown coordinator → reasoning → worker → light', () => {
    const calls = [
      call('delegate', 'claude-haiku-4-5', 10, 5),
      call('delegate', 'claude-opus-4-8', 10, 5),
      call('delegate', COORD, 10, 5),
      call('enact_capability', 'DeepSeek-V3.2', 10, 5),
    ];
    const roles = aggregateCost(calls, COORD).perModel.map((m) => m.role);
    expect(roles).toEqual(['coordinator', 'reasoning', 'worker', 'light']);
  });

  it('prices cache-read far below fresh input, not as fresh input (metering fix)', async () => {
    // A coordinator re-sends its whole context each loop turn, so most of its
    // "input" is cache-read. Pricing it as fresh input overstated the seat cost
    // by ~an order of magnitude (opus: $51 vs the real ~$10-15).
    await warmRegistry(); // pricing needs the catalog loaded
    const M = 'claude-opus-4-8'; // input rate $15/M; cache-read defaults to ~1/10th
    const fresh = aggregateCost(
      [{ tool: 'loop', model: M, tokensIn: 100_000, tokensOut: 0, ms: 1 }],
      'mistral-small-latest'
    ).totalCostUSD;
    const cached = aggregateCost(
      [{ tool: 'loop', model: M, tokensIn: 0, tokensOut: 0, cacheRead: 100_000, ms: 1 }],
      'mistral-small-latest'
    ).totalCostUSD;
    expect(fresh).toBeGreaterThan(0);
    expect(cached).toBeGreaterThan(0);
    // cache-read is materially cheaper than fresh input — the whole point.
    expect(cached).toBeLessThan(fresh * 0.5);
  });

  it('is fully costed only when every model that ran had a catalog rate', () => {
    // A made-up id the catalog can't price keeps its tokens but scores $0 and is
    // named — so the total reads as a floor, not a silent under-count.
    const b = aggregateCost([call('delegate', 'no-such-model-xyz', 10, 5)], COORD);
    expect(b.fullyCosted).toBe(false);
    expect(b.uncosted).toContain('no-such-model-xyz');
    expect(b.perModel[0]).toMatchObject({ costUSD: 0, uncosted: true, tokensIn: 10 });
  });
});

const DTCG = {
  color: {
    $type: 'color',
    brand: { $value: '#00703c' },
    // a semantic token aliasing the primitive → the alias layer
    text: { $value: '{color.brand}' },
  },
  space: {
    $type: 'dimension',
    sm: { $value: '8px' },
  },
};

describe('collectTokens — walks the DTCG tree with inherited $type', () => {
  it('finds every $value token and inherits the group $type', () => {
    const tokens = collectTokens(DTCG);
    expect(tokens.map((t) => t.path).sort()).toEqual(['color.brand', 'color.text', 'space.sm']);
    // $type inherited from the nearest ancestor.
    expect(tokens.find((t) => t.path === 'color.brand')?.type).toBe('color');
    expect(tokens.find((t) => t.path === 'space.sm')?.type).toBe('dimension');
  });

  it('yields nothing for a non-token shape rather than throwing', () => {
    expect(collectTokens('not an object')).toEqual([]);
    expect(collectTokens(null)).toEqual([]);
  });
});

describe('buildChecklist — the done-well checks over a token set', () => {
  it('passes the dimensions present and flags the ones missing', () => {
    const items = Object.fromEntries(buildChecklist(DTCG).map((c) => [c.id, c.ok]));
    expect(items['has-tokens']).toBe(true);
    expect(items['alias-layer']).toBe(true); // color.text aliases color.brand
    expect(items['colour-dimension']).toBe(true);
    expect(items['space-dimension']).toBe(true);
    expect(items['type-dimension']).toBe(false); // no typography tokens
  });

  it('flags a flat primitive-only set as missing the alias layer', () => {
    const flat = { color: { $type: 'color', brand: { $value: '#00703c' } } };
    const alias = buildChecklist(flat).find((c) => c.id === 'alias-layer');
    expect(alias?.ok).toBe(false);
  });
});

describe('judgeQuality — the whole verdict over produced text', () => {
  it('reads no-token output as a legible fail, not a crash', () => {
    const v = judgeQuality('I built the sites but here is just prose, no token file.');
    expect(v.foundTokens).toBe(false);
    expect(v.passes).toBe(false);
    expect(v.checklist).toEqual([]);
  });

  it('extracts a fenced DTCG token set and builds the checklist over it', () => {
    const v = judgeQuality('Here is the token set:\n```json\n' + JSON.stringify(DTCG) + '\n```');
    expect(v.foundTokens).toBe(true);
    expect(v.checklist.map((c) => c.id)).toContain('alias-layer');
    // the checklist ran over the parsed tokens (alias layer detected)
    expect(v.checklist.find((c) => c.id === 'alias-layer')?.ok).toBe(true);
  });
});
