import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import {
  manifestPath,
  loadManifest,
  renderProjectDoctrine,
  composeInstructions,
  type AigencyManifest,
} from '../src/manifest.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/aigency.json', import.meta.url));

describe('manifestPath', () => {
  it('prefers an explicit --manifest arg (resolved to absolute)', () => {
    const p = manifestPath(['node', 'bin.js', '--manifest', '/srv/proj/aigency.json'], '/wherever');
    expect(p).toBe('/srv/proj/aigency.json');
  });

  it('falls back to aigency.json in the working directory', () => {
    expect(manifestPath(['node', 'bin.js'], '/srv/proj')).toBe('/srv/proj/aigency.json');
  });

  it('ignores a --manifest flag with no following value', () => {
    expect(manifestPath(['node', 'bin.js', '--manifest'], '/srv/proj')).toBe(
      '/srv/proj/aigency.json'
    );
  });
});

describe('loadManifest', () => {
  it('parses a real manifest fixture', () => {
    const m = loadManifest(FIXTURE);
    expect(m?.notion?.databases?.['work_tracker']).toBe('aaaa1111-2222-3333-4444-555566667777');
  });

  it('returns null (no-project mode) when the file is missing', () => {
    expect(loadManifest('/no/such/aigency.json')).toBeNull();
  });

  it('returns null when the file is not valid JSON', () => {
    expect(loadManifest(fileURLToPath(new URL('./manifest.test.ts', import.meta.url)))).toBeNull();
  });
});

describe('renderProjectDoctrine', () => {
  it('names the board, record, and ADRs as dashless Notion URLs', () => {
    const section = renderProjectDoctrine(loadManifest(FIXTURE)!);
    expect(section).toContain('## This project');
    // work_tracker id, dashes stripped
    expect(section).toContain('https://www.notion.so/aaaa1111222233334444555566667777');
    // workspaceRootPageId as the project record
    expect(section).toContain('https://www.notion.so/11112222333344445555666677778888');
    // adrs db
    expect(section).toContain('https://www.notion.so/bbbb1111222233334444555566667777');
    expect(section).toContain('put work-shaped items here as cards');
  });

  it('falls back to the start_here page as the record when no workspace root', () => {
    const m: AigencyManifest = {
      notion: { pages: { start_here: 'cccc1111-2222-3333-4444-555566667777' } },
    };
    expect(renderProjectDoctrine(m)).toContain(
      'https://www.notion.so/cccc1111222233334444555566667777'
    );
  });

  it('returns null when there is nothing to point an agent at', () => {
    expect(renderProjectDoctrine({})).toBeNull();
    expect(renderProjectDoctrine({ notion: {} })).toBeNull();
  });
});

describe('composeInstructions', () => {
  const BASE = 'UNIVERSAL DOCTRINE';

  it('appends the project section when a usable manifest is present', () => {
    const out = composeInstructions(BASE, loadManifest(FIXTURE));
    expect(out.startsWith(BASE)).toBe(true);
    expect(out).toContain('## This project');
  });

  it('returns the base unchanged in no-project mode', () => {
    expect(composeInstructions(BASE, null)).toBe(BASE);
  });

  it('returns the base unchanged when the manifest has nothing to point at', () => {
    expect(composeInstructions(BASE, { notion: {} })).toBe(BASE);
  });
});
