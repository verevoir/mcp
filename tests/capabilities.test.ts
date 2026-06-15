import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@verevoir/recipes/engine', () => ({
  FOUNDATIONAL: ['automated-testing'],
  provisionPractices: vi.fn(),
  retrieveCapabilities: vi.fn(),
}));
vi.mock('@verevoir/recipes', () => ({
  // parseCapability returns a minimal descriptor; the body's first line is the
  // human description the frame surfaces.
  parseCapability: (idHint: string, raw: string) => ({
    type: idHint,
    postcondition: `produce ${idHint}`,
    description: raw.split('\n')[0],
    composes: [],
    guidance: '',
  }),
}));
vi.mock('../src/router.js', () => ({
  pickSourceAdapter: vi.fn(),
  resolveSourceEnv: vi.fn(() => ({})),
}));
vi.mock('../src/embedder.js', () => ({ fetchEmbedder: vi.fn() }));

import {
  retrieveCapabilities,
  renderCapabilities,
  provisionFrame,
  clearCapabilityCorpusMemo,
} from '../src/tools/provision.js';
import { pickSourceAdapter } from '../src/router.js';
import { retrieveCapabilities as recipesRetrieve } from '@verevoir/recipes/engine';
import { fetchEmbedder } from '../src/embedder.js';

/** An adapter serving practice and/or capability corpus dirs. */
function corpusAdapter(opts: {
  practices?: Record<string, string>;
  capabilities?: Record<string, string>;
}) {
  const practices = opts.practices ?? {};
  const capabilities = opts.capabilities ?? {};
  const fileList = (dir: string, ids: string[]) =>
    ids.map((id) => ({ type: 'file', name: `${id}.md`, path: `${dir}/${id}.md`, sha: '' }));
  return {
    listFiles: async (_e: unknown, _s: unknown, dir: string) => {
      if (dir === 'corpus/practices') return fileList(dir, Object.keys(practices));
      if (dir === 'corpus/capabilities') return fileList(dir, Object.keys(capabilities));
      return [];
    },
    readFile: async (_e: unknown, _s: unknown, path: string) => {
      const pid = path.replace('corpus/practices/', '').replace(/\.md$/, '');
      if (path.startsWith('corpus/practices/') && practices[pid] != null)
        return { content: practices[pid] };
      const cid = path.replace('corpus/capabilities/', '').replace(/\.md$/, '');
      if (path.startsWith('corpus/capabilities/') && capabilities[cid] != null)
        return { content: capabilities[cid] };
      throw new Error(`not found: ${path}`);
    },
  };
}

/** A recipes `retrieveCapabilities` that surfaces the corpus in order —
 * deterministic. Mirrors the real `{ type, summary }` shape so the MCP wrapper
 * (corpus load + embedder guard) is what's under test, not the ranking. */
function fakeMatcher() {
  return vi
    .mocked(recipesRetrieve)
    .mockImplementation(
      async (
        _prose: string,
        corpus: { type: string; description?: string; postcondition?: string }[],
        _embedder: unknown,
        k: number = corpus.length
      ) =>
        corpus
          .slice(0, k)
          .map((c) => ({ type: c.type, summary: c.description ?? c.postcondition ?? '' })) as never
    );
}

const fakeEmbedder = { id: 'fake', embed: async () => [[1]] };

beforeEach(() => {
  clearCapabilityCorpusMemo();
  vi.mocked(pickSourceAdapter).mockReset();
  vi.mocked(recipesRetrieve).mockReset();
  vi.mocked(fetchEmbedder).mockReset();
  delete process.env.ANTHROPIC_API_KEY;
});

describe('renderCapabilities', () => {
  it('omits the section (null) when there are no capabilities', () => {
    expect(renderCapabilities(null)).toBeNull();
    expect(renderCapabilities([])).toBeNull();
  });

  it('renders one advisory line per capability', () => {
    const out = renderCapabilities([{ type: 'connect-existing-repos', summary: 'Connect a repo' }]);
    expect(out).toContain('advisory');
    expect(out).toContain('connect-existing-repos');
    expect(out).toContain('Connect a repo');
  });
});

describe('retrieveCapabilities', () => {
  it('returns null when no embeddings endpoint is configured', async () => {
    vi.mocked(fetchEmbedder).mockReturnValue(null);
    expect(await retrieveCapabilities('build a thing')).toBeNull();
  });

  it('surfaces the retrieved capabilities with their descriptions', async () => {
    vi.mocked(fetchEmbedder).mockReturnValue(fakeEmbedder as never);
    vi.mocked(pickSourceAdapter).mockResolvedValue(
      corpusAdapter({
        capabilities: {
          'connect-existing-repos': 'Connect a repo and review it',
          'deploy-walking-skeleton': 'Deploy a runnable skeleton',
        },
      }) as never
    );
    fakeMatcher();

    const caps = await retrieveCapabilities('attach my github repo');
    expect(caps?.map((c) => c.type)).toEqual(['connect-existing-repos', 'deploy-walking-skeleton']);
    expect(caps?.[0].summary).toBe('Connect a repo and review it');
  });
});

describe('provisionFrame with the capability axis', () => {
  it('prepends the capabilities section to the practices frame', async () => {
    vi.mocked(fetchEmbedder).mockReturnValue(fakeEmbedder as never);
    vi.mocked(pickSourceAdapter).mockResolvedValue(
      corpusAdapter({
        practices: { 'automated-testing': '# Automated testing\nWrite tests.' },
        capabilities: { 'connect-existing-repos': 'Connect a repo and review it' },
      }) as never
    );
    fakeMatcher();

    const frame = await provisionFrame('attach my repo and add a feature');

    // capability section, then the separator, then the practice body
    expect(frame).toContain('Capabilities that may fit');
    expect(frame).toContain('connect-existing-repos');
    expect(frame).toContain('===');
    expect(frame).toContain('Write tests.');
    expect(frame.indexOf('connect-existing-repos')).toBeLessThan(frame.indexOf('Write tests.'));
  });

  it('returns practices only when no embeddings endpoint is configured', async () => {
    vi.mocked(fetchEmbedder).mockReturnValue(null);
    vi.mocked(pickSourceAdapter).mockResolvedValue(
      corpusAdapter({
        practices: { 'automated-testing': '# Automated testing\nWrite tests.' },
      }) as never
    );

    const frame = await provisionFrame('add a feature');
    expect(frame).toContain('Write tests.');
    expect(frame).not.toContain('Capabilities that may fit');
  });
});
