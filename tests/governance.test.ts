import { describe, it, expect, vi } from 'vitest';

vi.mock('@verevoir/context', () => ({ wrapWithCache: (a: unknown) => a }));
vi.mock('../src/router.js', () => ({
  pickSourceAdapter: vi.fn(),
  resolveSourceEnv: vi.fn(() => ({})),
}));

import {
  loadGovernanceIndex,
  filterGovernance,
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
});
