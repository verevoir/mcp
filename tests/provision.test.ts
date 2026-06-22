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
  reasoningProvidersSummary,
  classifyTaggingError,
  listPracticeIds,
  loadConcernMenu,
  renderMenu,
  clearConcernMenuMemo,
  corpusBoundaryBanner,
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

  it('renders a legible classified reason on failure, not a raw provider error dump', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    // A provider 401 whose raw message is a multi-line JSON blob.
    vi.mocked(provisionPractices).mockRejectedValue(
      Object.assign(
        new Error(`401
{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}`),
        { status: 401 }
      )
    );
    vi.mocked(pickSourceAdapter).mockResolvedValue(
      adapterWith({
        'automated-testing': practice('Automated testing', 'verified', 'Write tests.'),
        'input-validation': practice('Input validation', 'defended', 'Validate input.'),
      }) as never
    );

    const frame = await provisionFrame({ prose: 'do the thing', autoTag: true });

    // The operator learns it was the key, expired/revoked — not a JSON dump.
    expect(frame).toContain('concern-tagging failed');
    expect(frame).toMatch(/expired.*revoked|expired or revoked/i);
    expect(frame).not.toContain('authentication_error');
    // …and it still degrades to the floor rather than blocking the work.
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

describe('classifyTaggingError (STDIO-367 — legible degrade reason)', () => {
  it('reads a 401 status as an expired-or-revoked key', () => {
    expect(classifyTaggingError(Object.assign(new Error('nope'), { status: 401 }))).toMatch(
      /401.*expired|expired.*revoked/i
    );
  });

  it('reads a 429 status as a rate limit', () => {
    expect(classifyTaggingError(Object.assign(new Error('slow down'), { status: 429 }))).toMatch(
      /rate-limited.*429/i
    );
  });

  it('reads a 5xx status as a provider server error', () => {
    expect(classifyTaggingError(Object.assign(new Error('boom'), { status: 503 }))).toMatch(
      /server error.*503/i
    );
  });

  it('reads a network code as an unreachable provider', () => {
    expect(
      classifyTaggingError(Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }))
    ).toMatch(/could not reach.*ECONNREFUSED/i);
  });

  it('recovers an auth failure carried only in the message text', () => {
    expect(classifyTaggingError(new Error('Request failed: 401 Unauthorized'))).toMatch(
      /expired|revoked/i
    );
  });

  it('reads a status nested under .response (axios / openai-compat shape)', () => {
    expect(
      classifyTaggingError({ response: { status: 429 }, message: 'Too Many Requests' })
    ).toMatch(/rate-limited.*429/i);
  });

  it('reads a status from the cause chain (Node fetch wraps the real error)', () => {
    const wrapped = Object.assign(new Error('fetch failed'), { cause: { status: 401 } });
    expect(classifyTaggingError(wrapped)).toMatch(/401.*expired|expired.*revoked/i);
  });

  it('reads a status from an AggregateError-style .errors list', () => {
    const agg = Object.assign(new Error('all attempts failed'), {
      errors: [{ message: 'a' }, { status: 503 }],
    });
    expect(classifyTaggingError(agg)).toMatch(/server error.*503/i);
  });

  it('prefers an error status on .cause over a benign 200 on the outer .response', () => {
    // OpenAI-compat SDKs carry a 200-ish response shell while the real failure
    // sits on .cause — the operative status must win, not the benign one.
    const wrapped = Object.assign(new Error('wrapped'), {
      response: { status: 200 },
      cause: { status: 401 },
    });
    expect(classifyTaggingError(wrapped)).toMatch(/401.*expired|expired.*revoked/i);
  });

  it('does NOT treat "reconnect"/"preconnect" prose as a network failure', () => {
    // The old `econn` substring misfired on any word containing "econn".
    expect(classifyTaggingError(new Error('attempting to reconnect the websocket pool'))).toBe(
      'attempting to reconnect the websocket pool'
    );
  });

  it('does NOT treat a bare digit in incidental text as a status', () => {
    // The old version misfired here, asserting a false cause.
    const reason = classifyTaggingError(new Error('Loaded 401 practices from the corpus'));
    expect(reason).not.toMatch(/rejected the key|rate-limited/i);
    expect(reason).toBe('Loaded 401 practices from the corpus');
  });

  it('never throws, even when the error reads its fields through throwing getters', () => {
    const hostile = {
      get status(): never {
        throw new Error('boom');
      },
      get message(): never {
        throw new Error('boom');
      },
    };
    // The whole point of the catch this runs inside is to never block the work.
    expect(() => classifyTaggingError(hostile)).not.toThrow();
    expect(typeof classifyTaggingError(hostile)).toBe('string');
  });

  it('falls back to the first line of the message, never a multi-line dump', () => {
    const reason = classifyTaggingError(
      new Error(`something odd happened
with a stack
trace below`)
    );
    expect(reason).toBe('something odd happened');
    expect(reason).not.toContain('stack');
  });

  it('redacts an echoed credential from the fallback reason', () => {
    const reason = classifyTaggingError(
      new Error('Authorization header bearer sk-live-ABC123XYZ456 DEF malformed')
    );
    expect(reason).not.toContain('sk-live-ABC123XYZ456');
    expect(reason).toContain('redacted');
  });

  it('redacts a JWT echoed in the fallback reason', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dQw4w9WgXcQ1234567890abcdef';
    const reason = classifyTaggingError(new Error(`bad token ${jwt} rejected`));
    expect(reason).not.toContain('eyJ');
    expect(reason).toContain('redacted');
  });

  it('leaves ordinary diagnostic prose legible (no over-redaction)', () => {
    // No long letter+digit run, so nothing is scrubbed — the reason stays useful.
    const reason = classifyTaggingError(new Error('api-server-unreachable after 3 retries'));
    expect(reason).toBe('api-server-unreachable after 3 retries');
  });

  it('handles a non-Error throwable without crashing', () => {
    expect(classifyTaggingError('just a string')).toBe('just a string');
    expect(classifyTaggingError(null)).toBe('unknown error');
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

describe('reasoningProvidersSummary (STDIO-377)', () => {
  const KEYS = [
    'ANTHROPIC_API_KEY',
    'GEMINI_API_KEY',
    'OPENAI_API_KEY',
    'DEEPSEEK_API_KEY',
    'SAMBA_NOVA_API_KEY',
    'MISTRAL_API_KEY',
  ];
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('lists every supported reasoning provider', () => {
    const s = reasoningProvidersSummary();
    for (const p of ['anthropic', 'google', 'openai', 'deepseek', 'samba', 'mistral']) {
      expect(s).toContain(p);
    }
  });

  it('names the providers configured on this host', () => {
    process.env.DEEPSEEK_API_KEY = 'sk-x';
    expect(reasoningProvidersSummary()).toContain('Configured on this host: deepseek');
  });

  it('prompts to configure one when none are set', () => {
    expect(reasoningProvidersSummary()).toContain('None configured');
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

describe('corpus poisoning — trust-boundary banner + provenance (STDIO-399)', () => {
  const savedCorpusUrl = process.env.AIGENCY_GUARDRAILS_URL;
  afterEach(() => {
    if (savedCorpusUrl === undefined) delete process.env.AIGENCY_GUARDRAILS_URL;
    else process.env.AIGENCY_GUARDRAILS_URL = savedCorpusUrl;
  });

  it('states the corpus is the bar for standards, not a channel for commands, and routes an embedded instruction to a finding', () => {
    const banner = corpusBoundaryBanner('https://github.com/verevoir/aigency-guardrails');
    // The boundary the model is told to hold: corpus text is standards…
    expect(banner).toMatch(/standards/i);
    expect(banner).toMatch(/not a channel for commands/i);
    // …and an instruction smuggled in a body is a finding to report, not to obey.
    expect(banner).toMatch(/corpus-poisoning finding/i);
    expect(banner).toMatch(/report, not an instruction to follow/i);
  });

  it('adds no provenance note when the corpus is the canonical source', () => {
    const banner = corpusBoundaryBanner('https://github.com/verevoir/aigency-guardrails');
    expect(banner).not.toMatch(/provenance/i);
    expect(banner).not.toMatch(/non-canonical/i);
  });

  it('discloses provenance when the corpus is loaded from a non-canonical source, naming it', () => {
    const banner = corpusBoundaryBanner('https://github.com/someone-else/forked-corpus');
    expect(banner).toMatch(/non-canonical/i);
    expect(banner).toContain('https://github.com/someone-else/forked-corpus');
  });

  it('prepends the boundary banner to every provisioned frame, above the governance it injects', async () => {
    vi.mocked(pickSourceAdapter).mockResolvedValue(
      adapterWith({
        'automated-testing': practice('Automated testing', 'behaviour is verified', 'Write tests.'),
        'input-validation': practice('Input validation', 'the boundary is defended', 'Validate.'),
      }) as never
    );

    const frame = await provisionFrame('add an endpoint');

    // The banner is present and sits above the governance bodies, not after them.
    expect(frame).toMatch(/corpus-poisoning finding/i);
    expect(frame.indexOf('corpus-poisoning finding')).toBeLessThan(frame.indexOf('Write tests.'));
  });
});
