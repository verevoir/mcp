import { describe, it, expect } from 'vitest';
import {
  localDesignToolingDir,
  extractTokenJson,
  designPackVerifier,
  resolveVerifier,
  type DesignTooling,
} from '../src/tools/design-gate.js';

describe('localDesignToolingDir', () => {
  it('returns null for a remote (github) source — tooling is not on disk', () => {
    expect(localDesignToolingDir('https://github.com/verevoir/aigency-guardrails')).toBeNull();
    expect(localDesignToolingDir('git@github.com:verevoir/aigency-guardrails.git')).toBeNull();
  });

  it('returns the real corpus dir for the local checkout', () => {
    // The actual guardrails clone in this repo holds tooling/design.
    const dir = localDesignToolingDir(
      '/Users/adamsurgenor/Projects/Home/agency/projects/aigency-guardrails'
    );
    expect(dir).toBe('/Users/adamsurgenor/Projects/Home/agency/projects/aigency-guardrails');
  });

  it('returns null for a local path with no design tooling', () => {
    expect(localDesignToolingDir('/tmp/definitely-not-a-corpus-xyz')).toBeNull();
  });
});

describe('extractTokenJson', () => {
  it('pulls JSON out of a ```json fence', () => {
    const out = extractTokenJson('here you go:\n```json\n{"a":1}\n```\nthanks');
    expect(out && JSON.parse(out)).toEqual({ a: 1 });
  });

  it('pulls a bare balanced object out of surrounding prose', () => {
    const out = extractTokenJson('prose before {"a":{"b":2}} prose after');
    expect(out && JSON.parse(out)).toEqual({ a: { b: 2 } });
  });

  it('returns the whole object when the body is just JSON', () => {
    const out = extractTokenJson('{"$schema":"x","color":{}}');
    expect(out && JSON.parse(out)).toEqual({ $schema: 'x', color: {} });
  });

  it('returns null when nothing parses', () => {
    expect(extractTokenJson('no json here at all')).toBeNull();
    expect(extractTokenJson('{ not: valid json }')).toBeNull();
  });
});

// A fake tooling double — verifyFiles echoes a verdict driven by the test, so we
// assert the verifier WIRING (extract → render → verifyFiles → VerifyResult)
// without depending on the real DTCG checks (those are the corpus's own tests).
function fakeTooling(verdict: {
  ok: boolean;
  findings: { kind: string; file?: string; where?: string; message: string }[];
}): DesignTooling {
  return {
    renderTokenView: () => '## view',
    verifyFiles: (files) => {
      // Prove the verifier built the expected pack shape.
      const paths = Object.keys(files);
      expect(paths.some((p) => p.endsWith('.tokens.json'))).toBe(true);
      expect(paths.some((p) => p.endsWith('.tokens.md'))).toBe(true);
      return verdict;
    },
  };
}

describe('designPackVerifier', () => {
  it('passes clean tokens through to a clean verdict', async () => {
    const v = designPackVerifier(fakeTooling({ ok: true, findings: [] }), 'generate-design-tokens');
    const res = await v({
      capability: 'generate-design-tokens',
      verify: 'design-pack',
      result: '{"color":{}}',
    });
    expect(res.ok).toBe(true);
    expect(res.findings).toEqual([]);
  });

  it('surfaces the gate findings for a re-produce', async () => {
    const findings = [{ kind: 'DTCG', message: 'leaf missing $value' }];
    const v = designPackVerifier(fakeTooling({ ok: false, findings }), 'generate-design-tokens');
    const res = await v({
      capability: 'generate-design-tokens',
      verify: 'design-pack',
      result: '```json\n{"color":{}}\n```',
    });
    expect(res.ok).toBe(false);
    expect(res.findings[0].kind).toBe('DTCG');
  });

  it('fails closed with a PARSE finding when no JSON is produced', async () => {
    const v = designPackVerifier(fakeTooling({ ok: true, findings: [] }), 'generate-design-tokens');
    const res = await v({
      capability: 'generate-design-tokens',
      verify: 'design-pack',
      result: 'I could not produce tokens.',
    });
    expect(res.ok).toBe(false);
    expect(res.findings[0].kind).toBe('PARSE');
  });
});

describe('resolveVerifier', () => {
  it('returns null for a non-design verify name', async () => {
    expect(await resolveVerifier('some-other-gate', 'x')).toBeNull();
  });

  it('returns null for design-pack when the corpus is remote (no local tooling)', async () => {
    expect(
      await resolveVerifier(
        'design-pack',
        'generate-design-tokens',
        'https://github.com/verevoir/aigency-guardrails'
      )
    ).toBeNull();
  });
});
