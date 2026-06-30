import { describe, it, expect, beforeEach } from 'vitest';
import {
  pickToolingFiles,
  loadDesignTooling,
  clearDesignToolingMemo,
  extractTokenJson,
  designPackVerifier,
  type DesignTooling,
} from '../src/tools/design-gate.js';

beforeEach(() => clearDesignToolingMemo());

describe('pickToolingFiles', () => {
  it('keeps the .mjs sources and drops tests and non-mjs', () => {
    const picked = pickToolingFiles([
      { type: 'file', name: 'verify-pack.mjs', path: 'tooling/design/verify-pack.mjs' },
      { type: 'file', name: 'generate.mjs', path: 'tooling/design/generate.mjs' },
      { type: 'file', name: 'gate.test.mjs', path: 'tooling/design/gate.test.mjs' },
      { type: 'file', name: 'README.md', path: 'tooling/design/README.md' },
      { type: 'dir', name: 'sub', path: 'tooling/design/sub' },
    ]);
    expect(picked.map((f) => f.name).sort()).toEqual(['generate.mjs', 'verify-pack.mjs']);
  });
});

// Stub tooling modules — minimal real .mjs the loader materialises + imports,
// so the materialise→import path is exercised hermetically (no corpus, no
// network). verify-pack echoes a verdict from the token JSON it's handed.
const STUB_FILES: Record<string, string> = {
  'verify-pack.mjs':
    'export function verifyFiles(files){' +
    'const json=Object.entries(files).find(([p])=>p.endsWith(".tokens.json"));' +
    'const ok=json && JSON.parse(json[1]).ok===true;' +
    'return ok?{ok:true,findings:[]}:{ok:false,findings:[{kind:"DTCG",message:"stub reject"}]};}',
  'generate.mjs': 'export function renderTokenView(){return "## view";}',
};

describe('loadDesignTooling', () => {
  it('materialises fetched tooling to a temp dir and imports verifyFiles + renderTokenView', async () => {
    const tooling = await loadDesignTooling('any-url', async () => STUB_FILES);
    expect(tooling).not.toBeNull();
    expect(typeof tooling!.verifyFiles).toBe('function');
    expect(tooling!.renderTokenView(null)).toBe('## view');
    expect(tooling!.verifyFiles({ 'x.tokens.json': '{"ok":true}' }).ok).toBe(true);
    expect(tooling!.verifyFiles({ 'x.tokens.json': '{"ok":false}' }).ok).toBe(false);
  });

  it('returns null when the fetch finds no tooling (remote unreachable / empty)', async () => {
    expect(await loadDesignTooling('any-url', async () => null)).toBeNull();
  });

  it('returns null when the tooling is missing its required modules', async () => {
    expect(
      await loadDesignTooling('any-url', async () => ({
        'generate.mjs': STUB_FILES['generate.mjs'],
      }))
    ).toBeNull();
  });

  it('never throws when the fetch rejects — degrades to null', async () => {
    expect(
      await loadDesignTooling('any-url', async () => {
        throw new Error('network down');
      })
    ).toBeNull();
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

  it('returns null when nothing parses', () => {
    expect(extractTokenJson('no json here at all')).toBeNull();
    expect(extractTokenJson('{ not: valid json }')).toBeNull();
  });
});

function fakeTooling(verdict: {
  ok: boolean;
  findings: { kind: string; file?: string; where?: string; message: string }[];
}): DesignTooling {
  return {
    renderTokenView: () => '## view',
    verifyFiles: (files) => {
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
