import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@verevoir/recipes/engine', () => ({
  FOUNDATIONAL: ['automated-testing', 'input-validation'],
  provisionPractices: vi.fn(),
}));
vi.mock('../src/router.js', () => ({
  pickSourceAdapter: vi.fn(),
  resolveSourceEnv: vi.fn(() => ({})),
}));

import {
  provisionFrame,
  loadPracticeBodies,
  renderFrame,
  reasoningProvider,
} from '../src/tools/provision.js';
import { pickSourceAdapter } from '../src/router.js';
import { provisionPractices } from '@verevoir/recipes/engine';

/** An adapter whose corpus/practices dir holds exactly the given id→body map. */
function adapterWith(bodies: Record<string, string>) {
  return {
    listFiles: async (_e: unknown, _s: unknown, dir: string) =>
      dir === 'corpus/practices'
        ? Object.keys(bodies).map((id) => ({
            type: 'file',
            name: `${id}.md`,
            path: `corpus/practices/${id}.md`,
            sha: '',
          }))
        : [],
    readFile: async (_e: unknown, _s: unknown, path: string) => {
      const id = path.replace('corpus/practices/', '').replace(/\.md$/, '');
      if (bodies[id] != null) return { content: bodies[id] };
      throw new Error(`not found: ${path}`);
    },
  };
}

const savedKey = process.env.ANTHROPIC_API_KEY;

beforeEach(() => {
  vi.mocked(pickSourceAdapter).mockReset();
  vi.mocked(provisionPractices).mockReset();
  delete process.env.ANTHROPIC_API_KEY;
  // These tests exercise the practice axis only — keep the capability axis off
  // (no embeddings endpoint) so the frame is deterministic regardless of env.
  delete process.env.OPENAI_API_KEY;
  delete process.env.AIGENCY_EMBEDDINGS_API_KEY;
});

afterEach(() => {
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
});

describe('provisionFrame', () => {
  it('returns the foundational floor practices as text, with no model call, when no API key is set', async () => {
    vi.mocked(pickSourceAdapter).mockResolvedValue(
      adapterWith({
        'automated-testing': '# Automated testing\nWrite tests for behaviour.',
        'input-validation': '# Input validation\nValidate untrusted input.',
      }) as never
    );

    const frame = await provisionFrame('add a new HTTP endpoint');

    expect(frame).toContain('foundational floor only');
    expect(frame).toContain('Write tests for behaviour.');
    expect(frame).toContain('Validate untrusted input.');
    // The whole point of the floor: no reasoning call needed for it.
    expect(provisionPractices).not.toHaveBeenCalled();
  });

  it('tags concern-specific practices through provisionPractices when an API key is present', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    vi.mocked(provisionPractices).mockResolvedValue(['deploy-safety']);
    vi.mocked(pickSourceAdapter).mockResolvedValue(
      adapterWith({ 'deploy-safety': '# Deploy safety\nShip behind a switch.' }) as never
    );

    const frame = await provisionFrame('change the deploy pipeline');

    expect(provisionPractices).toHaveBeenCalledWith(
      { prose: 'change the deploy pipeline' },
      'sk-test',
      'reasoning',
      expect.any(Function)
    );
    expect(frame).toContain('concern-tagged for this work');
    expect(frame).toContain('Ship behind a switch.');
  });

  it('degrades to the foundational floor when concern-tagging throws (never blocks the work)', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    vi.mocked(provisionPractices).mockRejectedValue(new Error('anthropic down'));
    vi.mocked(pickSourceAdapter).mockResolvedValue(
      adapterWith({
        'automated-testing': '# Automated testing\nWrite tests.',
        'input-validation': '# Input validation\nValidate input.',
      }) as never
    );

    const frame = await provisionFrame('do the thing');

    expect(frame).toContain('concern-tagging failed');
    expect(frame).toContain('Write tests.');
  });

  it('reports the practices it provisioned even when none can be read from the corpus', async () => {
    // source resolves but has no practices dir → nothing readable
    vi.mocked(pickSourceAdapter).mockResolvedValue({
      listFiles: async () => [],
      readFile: async () => {
        throw new Error('nope');
      },
    } as never);

    const frame = await provisionFrame('build a feature');

    expect(frame).toContain('none could be');
    expect(frame).toContain('automated-testing');
    expect(frame).toContain('input-validation');
  });
});

describe('loadPracticeBodies', () => {
  it('skips a practice that cannot be read, keeping the rest', async () => {
    vi.mocked(pickSourceAdapter).mockResolvedValue(
      adapterWith({ 'automated-testing': '# Automated testing\nbody' }) as never
    );
    const loaded = await loadPracticeBodies(['automated-testing', 'does-not-exist']);
    expect(loaded.map((p) => p.id)).toEqual(['automated-testing']);
  });

  it('returns [] when the source itself is unreadable', async () => {
    vi.mocked(pickSourceAdapter).mockRejectedValue(new Error('no token'));
    expect(await loadPracticeBodies(['automated-testing'])).toEqual([]);
  });
});

describe('renderFrame', () => {
  it('names practices that were provisioned but could not be read', () => {
    const out = renderFrame([{ id: 'a', body: '# A\nalpha' }], ['a', 'b'], 'concern-tagged');
    expect(out).toContain('alpha');
    expect(out).toContain('Provisioned but unreadable: b');
  });
});

describe('reasoningProvider', () => {
  const saved = process.env.AIGENCY_REASONING_PROVIDER;
  afterEach(() => {
    if (saved === undefined) delete process.env.AIGENCY_REASONING_PROVIDER;
    else process.env.AIGENCY_REASONING_PROVIDER = saved;
  });

  it('defaults to Anthropic when unset (unchanged behaviour)', () => {
    delete process.env.AIGENCY_REASONING_PROVIDER;
    const p = reasoningProvider();
    expect(p.name).toBe('anthropic');
    expect(p.keyEnv).toBe('ANTHROPIC_API_KEY');
  });

  it('selects the configured provider and its key env (case-insensitive)', () => {
    process.env.AIGENCY_REASONING_PROVIDER = 'MisTraL';
    const p = reasoningProvider();
    expect(p.name).toBe('mistral');
    expect(p.keyEnv).toBe('MISTRAL_API_KEY');
  });

  it('falls back to Anthropic for an unknown provider', () => {
    process.env.AIGENCY_REASONING_PROVIDER = 'frobnicate';
    expect(reasoningProvider().name).toBe('anthropic');
  });
});
