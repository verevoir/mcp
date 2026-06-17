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
  listPracticeIds,
  loadConcernMenu,
  renderMenu,
  clearConcernMenuMemo,
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

/** A practice body with the `# Title` and `**Protects:**` line the menu reads. */
function practice(title: string, protects: string, rest = ''): string {
  return `# ${title}\n\n**Protects:** ${protects}\n${rest}`.trim();
}

const savedKey = process.env.ANTHROPIC_API_KEY;

beforeEach(() => {
  vi.mocked(pickSourceAdapter).mockReset();
  vi.mocked(provisionPractices).mockReset();
  clearConcernMenuMemo();
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

describe('provisionFrame — default catalogue (STDIO-348)', () => {
  it('returns the floor in full plus a menu of the concern practices, with no model call and no key', async () => {
    vi.mocked(pickSourceAdapter).mockResolvedValue(
      adapterWith({
        'automated-testing': practice('Automated testing', 'behaviour is verified', 'Write tests.'),
        'input-validation': practice(
          'Input validation',
          'the boundary is defended',
          'Validate input.'
        ),
        'deploy-safety': practice('Deploy safety', 'a bad deploy is caught early'),
        'secret-handling': practice('Secret handling', 'secrets are not leaked'),
      }) as never
    );

    const frame = await provisionFrame('add a new HTTP endpoint');

    // Floor comes back in full…
    expect(frame).toContain('foundational floor — always applies');
    expect(frame).toContain('Write tests.');
    expect(frame).toContain('Validate input.');
    // …and the concern practices come back as a menu (blurb, not full body).
    expect(frame).toContain('Concern practices available for this work');
    expect(frame).toContain('**deploy-safety** — a bad deploy is caught early');
    expect(frame).toContain('**secret-handling** — secrets are not leaked');
    expect(frame).not.toContain('a bad deploy is caught early\n\n---'); // not a full body block
    // The whole point: the coordinator narrows, so no reasoning call happens.
    expect(provisionPractices).not.toHaveBeenCalled();
  });

  it('omits the menu cleanly when only floor practices exist', async () => {
    vi.mocked(pickSourceAdapter).mockResolvedValue(
      adapterWith({
        'automated-testing': practice('Automated testing', 'behaviour is verified', 'Write tests.'),
        'input-validation': practice(
          'Input validation',
          'the boundary is defended',
          'Validate input.'
        ),
      }) as never
    );

    const frame = await provisionFrame('tiny change');

    expect(frame).toContain('Write tests.');
    expect(frame).not.toContain('Concern practices available');
  });
});

describe('provisionFrame — concerns pick', () => {
  it('returns the floor plus exactly the named concern bodies, no model call', async () => {
    vi.mocked(pickSourceAdapter).mockResolvedValue(
      adapterWith({
        'automated-testing': practice('Automated testing', 'behaviour is verified', 'Write tests.'),
        'input-validation': practice(
          'Input validation',
          'the boundary is defended',
          'Validate input.'
        ),
        'deploy-safety': practice(
          'Deploy safety',
          'a bad deploy is caught early',
          'Ship behind a switch.'
        ),
      }) as never
    );

    const frame = await provisionFrame({ concerns: ['deploy-safety'] });

    expect(frame).toContain('selected for this work');
    expect(frame).toContain('Write tests.'); // floor still included
    expect(frame).toContain('Ship behind a switch.'); // the chosen concern, in full
    expect(provisionPractices).not.toHaveBeenCalled();
  });

  it('does not double-count a concern that is already a floor practice', async () => {
    vi.mocked(pickSourceAdapter).mockResolvedValue(
      adapterWith({
        'automated-testing': practice('Automated testing', 'behaviour is verified', 'Write tests.'),
        'input-validation': practice(
          'Input validation',
          'the boundary is defended',
          'Validate input.'
        ),
      }) as never
    );

    const frame = await provisionFrame({ concerns: ['automated-testing'] });

    // 'automated-testing' appears once (as floor), not twice.
    expect(frame.match(/# Automated testing/g)?.length).toBe(1);
  });
});

describe('provisionFrame — autoTag (headless / weak top of stack)', () => {
  it('tags concern-specific practices through provisionPractices when autoTag and a key are set', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    vi.mocked(provisionPractices).mockResolvedValue(['deploy-safety']);
    vi.mocked(pickSourceAdapter).mockResolvedValue(
      adapterWith({
        'deploy-safety': practice('Deploy safety', 'caught early', 'Ship behind a switch.'),
      }) as never
    );

    const frame = await provisionFrame({ prose: 'change the deploy pipeline', autoTag: true });

    expect(provisionPractices).toHaveBeenCalledWith(
      { prose: 'change the deploy pipeline' },
      'sk-test',
      'reasoning',
      expect.any(Function)
    );
    expect(frame).toContain('concern-tagged for this work');
    expect(frame).toContain('Ship behind a switch.');
  });

  it('does not call the reasoning provider for autoTag when no key is set', async () => {
    vi.mocked(pickSourceAdapter).mockResolvedValue(
      adapterWith({
        'automated-testing': practice('Automated testing', 'verified', 'Write tests.'),
        'input-validation': practice('Input validation', 'defended', 'Validate input.'),
      }) as never
    );

    const frame = await provisionFrame({ prose: 'do the thing', autoTag: true });

    expect(provisionPractices).not.toHaveBeenCalled();
    expect(frame).toContain('set ANTHROPIC_API_KEY');
    expect(frame).toContain('Write tests.');
  });

  it('degrades to the foundational floor when concern-tagging throws (never blocks the work)', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    vi.mocked(provisionPractices).mockRejectedValue(new Error('anthropic down'));
    vi.mocked(pickSourceAdapter).mockResolvedValue(
      adapterWith({
        'automated-testing': practice('Automated testing', 'verified', 'Write tests.'),
        'input-validation': practice('Input validation', 'defended', 'Validate input.'),
      }) as never
    );

    const frame = await provisionFrame({ prose: 'do the thing', autoTag: true });

    expect(frame).toContain('concern-tagging failed');
    expect(frame).toContain('Write tests.');
  });

  it('reports the practices it provisioned even when none can be read from the corpus', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    vi.mocked(provisionPractices).mockResolvedValue(['automated-testing', 'input-validation']);
    // source resolves but has no practices dir → nothing readable
    vi.mocked(pickSourceAdapter).mockResolvedValue({
      listFiles: async () => [],
      readFile: async () => {
        throw new Error('nope');
      },
    } as never);

    const frame = await provisionFrame({ prose: 'build a feature', autoTag: true });

    expect(frame).toContain('none could be');
    expect(frame).toContain('automated-testing');
    expect(frame).toContain('input-validation');
  });
});

describe('the concern menu', () => {
  it('lists every non-floor practice with its Protects blurb', async () => {
    vi.mocked(pickSourceAdapter).mockResolvedValue(
      adapterWith({
        'automated-testing': practice('Automated testing', 'verified'),
        'input-validation': practice('Input validation', 'defended'),
        'deploy-safety': practice('Deploy safety', 'a bad deploy is caught early'),
      }) as never
    );

    const menu = await loadConcernMenu();

    // floor practices are excluded from the menu
    expect(menu.map((m) => m.id)).toEqual(['deploy-safety']);
    expect(menu[0]).toMatchObject({
      title: 'Deploy safety',
      protects: 'a bad deploy is caught early',
    });
  });

  it('renders a pick-list that tells the coordinator to call back with concerns', () => {
    const out = renderMenu([
      { id: 'deploy-safety', title: 'Deploy safety', protects: 'caught early' },
    ]);
    expect(out).toContain('concerns:');
    expect(out).toContain('**deploy-safety** — caught early');
  });
});

describe('listPracticeIds', () => {
  it('returns the sorted practice ids in the corpus', async () => {
    vi.mocked(pickSourceAdapter).mockResolvedValue(
      adapterWith({
        'input-validation': practice('Input validation', 'defended'),
        'automated-testing': practice('Automated testing', 'verified'),
      }) as never
    );
    expect(await listPracticeIds()).toEqual(['automated-testing', 'input-validation']);
  });

  it('returns [] when the source is unreadable', async () => {
    vi.mocked(pickSourceAdapter).mockRejectedValue(new Error('no token'));
    expect(await listPracticeIds()).toEqual([]);
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
