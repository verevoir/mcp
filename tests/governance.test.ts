import { describe, it, expect, vi } from 'vitest';

vi.mock('@verevoir/context', () => ({ wrapWithCache: (a: unknown) => a }));
vi.mock('../src/router.js', () => ({
  pickSourceAdapter: vi.fn(),
  resolveSourceEnv: vi.fn(() => ({})),
}));

import {
  loadGovernanceIndex,
  filterGovernance,
  resolveGovernanceSource,
  type GovernanceEntry,
} from '../src/tools/governance.js';
import { pickSourceAdapter } from '../src/router.js';
import type { AigencyManifest } from '../src/manifest.js';

const manifest: AigencyManifest = {
  notion: {
    workspaceRootPageId: 'ws',
    databases: { work_tracker: 'wt', adrs: 'adrs-id' },
    pages: { glossary: 'g-id', start_here: 'sh-id' },
  },
};

describe('filterGovernance', () => {
  const index: GovernanceEntry[] = [
    { title: 'The Capability Model', source: 's', path: 'a' },
    { title: 'Provisioning Foundation', source: 's', path: 'b' },
    { title: 'glossary', source: 's2', path: '' },
  ];

  it('returns the whole index when no query', () => {
    expect(filterGovernance(index, undefined)).toHaveLength(3);
  });

  it('narrows by case-insensitive substring on the title', () => {
    expect(filterGovernance(index, 'capability').map((e) => e.title)).toEqual([
      'The Capability Model',
    ]);
    expect(filterGovernance(index, 'PROVISION').map((e) => e.title)).toEqual([
      'Provisioning Foundation',
    ]);
  });

  it('returns nothing for a non-matching query (caller reports it)', () => {
    expect(filterGovernance(index, 'kubernetes')).toEqual([]);
  });

  it('tokenises and ranks by hits — a multi-word intent surfaces the best match', () => {
    const idx: GovernanceEntry[] = [
      {
        title: '011 the capability practice model',
        source: 's',
        path: 'governance/adrs/011-the-capability-practice-model.md',
        kind: 'ADR',
      },
      {
        title: 'addressability',
        source: 's',
        path: 'corpus/practices/addressability.md',
        kind: 'practice',
      },
    ];
    expect(filterGovernance(idx, 'capability practice model standard')[0].title).toBe(
      '011 the capability practice model'
    );
    expect(filterGovernance(idx, 'capability').map((e) => e.title)).toEqual([
      '011 the capability practice model',
    ]);
  });
});

describe('resolveGovernanceSource', () => {
  it('passes URLs and absolute paths through unchanged', () => {
    expect(resolveGovernanceSource('https://github.com/o/r', '/proj')).toBe(
      'https://github.com/o/r'
    );
    expect(resolveGovernanceSource('https://www.notion.so/abc', '/proj')).toBe(
      'https://www.notion.so/abc'
    );
    expect(resolveGovernanceSource('/abs/clone', '/proj')).toBe('/abs/clone');
  });

  it('resolves a relative source against the manifest directory', () => {
    expect(resolveGovernanceSource('projects/aigency-guardrails', '/home/proj')).toBe(
      '/home/proj/projects/aigency-guardrails'
    );
  });
});

describe('loadGovernanceIndex', () => {
  it('returns [] with no manifest', async () => {
    expect(await loadGovernanceIndex(null)).toEqual([]);
  });

  it('indexes the ADRs DB cards plus the named key pages', async () => {
    vi.mocked(pickSourceAdapter).mockResolvedValue({
      listFiles: async () => [
        { name: 'The Capability Model', type: 'file', path: 'cap-model', sha: '' },
        { name: 'Provisioning Foundation', type: 'file', path: 'prov', sha: '' },
      ],
    } as never);
    const index = await loadGovernanceIndex(manifest);
    const titles = index.map((e) => e.title);
    expect(titles).toContain('The Capability Model');
    expect(titles).toContain('Provisioning Foundation');
    // pages come from the manifest, humanised, with no fetch
    expect(titles).toContain('glossary');
    expect(titles).toContain('start here');
  });

  it('still indexes the pages when the ADRs source is unreadable', async () => {
    vi.mocked(pickSourceAdapter).mockRejectedValue(new Error('no token'));
    const index = await loadGovernanceIndex(manifest);
    expect(index.map((e) => e.title)).toEqual(['glossary', 'start here']);
  });

  it('indexes declared governance sources alongside the record, deriving kind', async () => {
    vi.mocked(pickSourceAdapter).mockResolvedValue({
      listFiles: async (_e: unknown, _s: unknown, prefix: string) => {
        if (prefix === 'governance/adrs')
          return [
            {
              name: '011-the-capability-practice-model.md',
              type: 'file',
              path: 'governance/adrs/011-the-capability-practice-model.md',
              sha: '',
            },
            {
              name: 'README.md',
              type: 'file',
              path: 'governance/adrs/README.md',
              sha: '',
            },
            {
              name: 'notes.txt',
              type: 'file',
              path: 'governance/adrs/notes.txt',
              sha: '',
            },
          ];
        if (prefix === 'corpus/practices')
          return [
            {
              name: 'addressability.md',
              type: 'file',
              path: 'corpus/practices/addressability.md',
              sha: '',
            },
          ];
        return []; // the Notion ADRs DB (prefix '') is empty here
      },
    } as never);
    const m: AigencyManifest = {
      notion: { databases: { adrs: 'adrs-id' }, pages: {} },
      governance: [
        {
          source: 'https://github.com/verevoir/aigency-guardrails',
          paths: ['governance/adrs', 'governance/principles.md', 'corpus/practices'],
        },
      ],
    };
    const index = await loadGovernanceIndex(m);
    const byTitle = Object.fromEntries(index.map((e) => [e.title, e]));
    // directory .md files listed; kind read off the path; non-.md skipped
    expect(byTitle['011 the capability practice model']?.kind).toBe('ADR');
    expect(byTitle['addressability']?.kind).toBe('practice');
    expect(index.some((e) => e.path.endsWith('notes.txt'))).toBe(false);
    // a single `.md` path is indexed directly, without a listing
    expect(byTitle['principles']?.kind).toBe('principle');
    // a README is titled by its folder, not a bare "readme"
    expect(byTitle['adrs — overview']?.kind).toBe('ADR');
  });
});
