import { describe, it, expect } from 'vitest';
import { extractTokenJson, designPackVerifier, resolveVerifier } from '../src/tools/design-gate.js';

describe('extractTokenJson', () => {
  it('pulls JSON out of a ```json fence', () => {
    const out = extractTokenJson('here you go:\n```json\n{"a":1}\n```\nthanks');
    expect(out && JSON.parse(out)).toEqual({ a: 1 });
  });

  it('pulls a bare balanced object out of surrounding prose', () => {
    const out = extractTokenJson('prose before {"a":{"b":2}} prose after');
    expect(out && JSON.parse(out)).toEqual({ a: { b: 2 } });
  });

  it('returns null when nothing parses', () => {
    expect(extractTokenJson('no json here at all')).toBeNull();
    expect(extractTokenJson('{ not: valid json }')).toBeNull();
  });
});

// designPackVerifier runs the REAL shared @verevoir/design-gate (zero-dep, pure,
// no network) — so these exercise the actual gate, not a stub. The verifier
// renders the generated view itself, so VIEW_DRIFT can't fire here; what's left
// is DTCG validity, which is the gate's real force.
const VALID = JSON.stringify({
  $schema: 'https://tr.designtokens.org/format/',
  color: { brand: { $value: '#1d70b8', $type: 'color' } },
});
const MISSING_TYPE = JSON.stringify({ color: { brand: { $value: '#fff' } } });

describe('designPackVerifier', () => {
  it('passes a valid DTCG token file', async () => {
    const v = designPackVerifier('generate-design-tokens');
    const res = await v({ capability: 'c', verify: 'design-pack', result: VALID });
    expect(res.ok).toBe(true);
    expect(res.findings).toEqual([]);
  });

  it('surfaces real gate findings (DTCG) for a malformed token, so the worker can fix them', async () => {
    const v = designPackVerifier('generate-design-tokens');
    const res = await v({
      capability: 'c',
      verify: 'design-pack',
      result: `\`\`\`json\n${MISSING_TYPE}\n\`\`\``,
    });
    expect(res.ok).toBe(false);
    expect(res.findings.some((f) => f.kind === 'DTCG')).toBe(true);
  });

  it('fails closed with a PARSE finding when no JSON is produced', async () => {
    const v = designPackVerifier('generate-design-tokens');
    const res = await v({
      capability: 'c',
      verify: 'design-pack',
      result: 'I could not produce tokens.',
    });
    expect(res.ok).toBe(false);
    expect(res.findings[0].kind).toBe('PARSE');
  });
});

describe('resolveVerifier', () => {
  it('returns a runnable verifier for design-pack (the shared package is always present)', async () => {
    expect(typeof (await resolveVerifier('design-pack', 'generate-design-tokens'))).toBe(
      'function'
    );
  });

  it('returns null for a verify name with no runner', async () => {
    expect(await resolveVerifier('some-other-gate', 'x')).toBeNull();
    expect(await resolveVerifier(undefined, 'x')).toBeNull();
  });
});
