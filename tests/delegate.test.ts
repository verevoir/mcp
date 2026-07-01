import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { registerModelCatalog, type PerModelUsage } from '@verevoir/llm';
import type { VerifyResult } from '@verevoir/recipes/engine';
import {
  delegate,
  workerConfig,
  workerSummary,
  resolveWorkerModel,
  clearWorkerModelsCache,
} from '../src/tools/delegate.js';
import { roundUsage } from '../src/metering.js';
import type { Reviewer } from '../src/tools/review.js';

const ENV = [
  'AIGENCY_WORKER_URL',
  'AIGENCY_WORKER_MODEL',
  'AIGENCY_WORKER_API_KEY',
  // Post-467 the worker IS the extraction tier, so "no worker configured" means
  // none of these set AND no provider serving the default (haiku). The extraction-tier
  // vars and the provider keys must be isolated too — otherwise a real env with provider
  // keys present makes a worker resolvable and the "no worker" assertions flip.
  'AIGENCY_MODEL_EXTRACTION',
  'AIGENCY_MODEL_EXTRACTION_URI',
  'AIGENCY_MODEL_EXTRACTION_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'DEEPSEEK_API_KEY',
  'SAMBA_NOVA_API_KEY',
  'MISTRAL_API_KEY',
];
const saved: Record<string, string | undefined> = {};
for (const k of ENV) saved[k] = process.env[k];

afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
});

function setEnv(model?: string, url?: string, apiKey?: string) {
  for (const k of ENV) delete process.env[k];
  if (model) process.env.AIGENCY_WORKER_MODEL = model;
  if (url) process.env.AIGENCY_WORKER_URL = url;
  if (apiKey) process.env.AIGENCY_WORKER_API_KEY = apiKey;
}

function okFetch(content: string) {
  return vi.fn((_url: string, _init: RequestInit) =>
    Promise.resolve({
      ok: true,
      json: async () => ({ choices: [{ message: { content } }] }),
    })
  );
}

// A provision stub so the governance path stays hermetic — the real
// `provisionFrame` reads the guardrails corpus and may make a reasoning call.
// `delegate` takes the provider as an injectable 2nd arg for exactly this.
const stubFrame = (text: string) => vi.fn(async (_prose: string) => text);

function bodyOf(fetchMock: ReturnType<typeof okFetch>) {
  const init = fetchMock.mock.calls[0][1];
  return JSON.parse(init.body as string) as {
    model: string;
    messages: { role: string; content: string }[];
  };
}

beforeEach(() => {
  clearWorkerModelsCache();
});

describe('workerConfig', () => {
  it('defaults the URL to Ollama and trims a trailing slash', () => {
    setEnv('qwen2.5:7b', 'http://localhost:11434/v1/');
    const c = workerConfig();
    expect(c.baseUrl).toBe('http://localhost:11434/v1');
    expect(c.model).toBe('qwen2.5:7b');
    expect(c.apiKey).toBeNull();
  });

  it('defaults the URL to Ollama when none is set', () => {
    setEnv('llama3.1:8b');
    expect(workerConfig().baseUrl).toBe('http://localhost:11434/v1');
  });
});

describe('delegate — transport', () => {
  it('returns a terse, config-opaque notice when no worker model is configured', async () => {
    setEnv();
    const out = await delegate({ prompt: 'do a thing' });
    expect(out).toContain('No worker model is configured');
    // the public surface must NOT leak the worker config recipe
    expect(out).not.toContain('AIGENCY_WORKER');
  });

  it('posts to the OpenAI-compatible endpoint and returns the worker text', async () => {
    setEnv('qwen2.5:7b');
    const fetchMock = okFetch('worker says hi');
    vi.stubGlobal('fetch', fetchMock);

    const out = await delegate({ prompt: 'summarise X', system: 'be terse', governed: false });

    expect(out).toBe('worker says hi');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:11434/v1/chat/completions');
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('qwen2.5:7b');
    expect(body.messages).toEqual([
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'summarise X' },
    ]);
    // local endpoint: no auth header
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it('sends a bearer token when a key is configured, and honours a per-call model override', async () => {
    setEnv('default-model', 'https://api.example.com/v1', 'sk-x');
    const fetchMock = okFetch('ok');
    vi.stubGlobal('fetch', fetchMock);

    await delegate({ prompt: 'p', model: 'override-model', governed: false });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.example.com/v1/chat/completions');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-x');
    expect(JSON.parse(init.body as string).model).toBe('override-model');
  });

  it('returns a clear message when the worker is unreachable', async () => {
    setEnv('qwen2.5:7b');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      })
    );
    const out = await delegate({ prompt: 'p', governed: false });
    expect(out).toContain('Could not reach the worker');
    expect(out).toContain('ollama serve');
  });

  it('surfaces a non-ok HTTP status from the worker', async () => {
    setEnv('qwen2.5:7b');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 404, text: async () => 'model not found' }))
    );
    const out = await delegate({ prompt: 'p', governed: false });
    expect(out).toContain('HTTP 404');
    expect(out).toContain('model not found');
  });
});

describe('delegate — governance (the frame travels with the task)', () => {
  it('is governed by default: provisions the task and prepends the frame to the worker system message', async () => {
    setEnv('qwen2.5:7b');
    const fetchMock = okFetch('done');
    vi.stubGlobal('fetch', fetchMock);
    const provision = stubFrame('THE BAR');

    const out = await delegate({ prompt: 'add a feature' }, provision);

    expect(out).toBe('done');
    expect(provision).toHaveBeenCalledWith('add a feature');
    expect(bodyOf(fetchMock).messages).toEqual([
      { role: 'system', content: 'THE BAR' },
      { role: 'user', content: 'add a feature' },
    ]);
  });

  it('governed: false skips provisioning entirely (throwaway work)', async () => {
    setEnv('qwen2.5:7b');
    const fetchMock = okFetch('ok');
    vi.stubGlobal('fetch', fetchMock);
    const provision = stubFrame('X');

    await delegate({ prompt: 'summarise this', governed: false }, provision);

    expect(provision).not.toHaveBeenCalled();
    expect(bodyOf(fetchMock).messages).toEqual([{ role: 'user', content: 'summarise this' }]);
  });

  it('prepends the provisioned frame before a caller system instruction', async () => {
    setEnv('qwen2.5:7b');
    const fetchMock = okFetch('ok');
    vi.stubGlobal('fetch', fetchMock);

    await delegate({ prompt: 'p', system: 'be terse' }, stubFrame('BAR'));

    expect(bodyOf(fetchMock).messages[0]).toEqual({ role: 'system', content: 'BAR\n\nbe terse' });
  });

  it('does not provision when no worker is configured (no wasted call)', async () => {
    setEnv();
    const provision = stubFrame('X');
    const out = await delegate({ prompt: 'p' }, provision);
    expect(out).toContain('No worker model is configured');
    expect(provision).not.toHaveBeenCalled();
  });
});

describe('workerSummary (STDIO-377)', () => {
  const KEYS = ['AIGENCY_WORKER_MODEL', 'AIGENCY_WORKER_URL', 'AIGENCY_WORKER_API_KEY'];
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

  it('reports no worker (and the Ollama default) when unconfigured', async () => {
    const s = await workerSummary(async () => null);
    expect(s).toContain('No worker is configured');
    expect(s).toContain('11434');
  });

  it('reports the configured worker model and url', async () => {
    process.env.AIGENCY_WORKER_MODEL = 'deepseek-chat';
    process.env.AIGENCY_WORKER_URL = 'https://api.deepseek.com';
    const s = await workerSummary(async () => null);
    expect(s).toContain('deepseek-chat');
    expect(s).toContain('api.deepseek.com');
  });

  it('lists the models the worker serves so a coordinator can pick one per call', async () => {
    process.env.AIGENCY_WORKER_MODEL = 'DeepSeek-V3.2';
    process.env.AIGENCY_WORKER_URL = 'https://api.sambanova.ai/v1';
    const s = await workerSummary(async () => ['DeepSeek-V3.2', 'Meta-Llama-3.3-70B-Instruct']);
    expect(s).toContain('Models this worker serves');
    expect(s).toContain('DeepSeek-V3.2');
    expect(s).toContain('Meta-Llama-3.3-70B-Instruct');
  });
});

describe('resolveWorkerModel (STDIO-379)', () => {
  const served = ['DeepSeek-V3.1', 'DeepSeek-V3.2', 'Meta-Llama-3.3-70B-Instruct'];

  it('passes an exact id straight through (case-insensitive)', () => {
    expect(resolveWorkerModel('DeepSeek-V3.2', served)).toBe('DeepSeek-V3.2');
    expect(resolveWorkerModel('deepseek-v3.2', served)).toBe('DeepSeek-V3.2');
  });

  it('resolves a loose family name to the newest served match', () => {
    expect(resolveWorkerModel('deepseek', served)).toBe('DeepSeek-V3.2');
    expect(resolveWorkerModel('llama', served)).toBe('Meta-Llama-3.3-70B-Instruct');
  });

  it('returns the request unchanged when nothing is served or nothing matches', () => {
    expect(resolveWorkerModel('deepseek', null)).toBe('deepseek');
    expect(resolveWorkerModel('mixtral', served)).toBe('mixtral');
  });
});

describe('delegate model resolution (STDIO-379)', () => {
  it("resolves a loose per-call model against the worker's served models", async () => {
    setEnv('DeepSeek-V3.2', 'https://api.sambanova.ai/v1', 'sk-x');
    // Registration caches the served models — simulate that here.
    await workerSummary(async () => [
      'DeepSeek-V3.1',
      'DeepSeek-V3.2',
      'Meta-Llama-3.3-70B-Instruct',
    ]);
    const fetchMock = okFetch('reviewed');
    vi.stubGlobal('fetch', fetchMock);

    await delegate({ prompt: 'review X', model: 'deepseek' }, stubFrame('FRAME'));

    // The loose "deepseek" was resolved to the newest served id before the call.
    expect(bodyOf(fetchMock).model).toBe('DeepSeek-V3.2');
  });
});

describe('delegate metering (STDIO-388)', () => {
  function fetchWithUsage(content: string, usage: unknown) {
    return vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: async () => ({ choices: [{ message: { content } }], usage }),
      })
    );
  }

  beforeEach(() => {
    delete process.env.AIGENCY_METER;
    registerModelCatalog([
      {
        provider: 'mtrtest',
        family: 'mtr-worker',
        modelClass: 'extraction',
        currentId: 'mtr-worker',
        rates: [0.6, 1.5],
        label: 'Metering Worker',
        prefixes: ['mtr-worker'],
      },
    ]);
  });

  afterEach(() => {
    delete process.env.AIGENCY_METER;
  });

  it('appends no footer when neither the meter arg nor the env is set', async () => {
    setEnv('mtr-worker', 'https://worker.example/v1', 'sk-x');
    vi.stubGlobal(
      'fetch',
      fetchWithUsage('reviewed', { prompt_tokens: 1000, completion_tokens: 500 })
    );

    const out = await delegate({ prompt: 'review', governed: false });

    expect(out).toBe('reviewed');
  });

  it('appends a cost table with the priced model when meter is totals-only', async () => {
    setEnv('mtr-worker', 'https://worker.example/v1', 'sk-x');
    vi.stubGlobal(
      'fetch',
      fetchWithUsage('reviewed', { prompt_tokens: 1000, completion_tokens: 500 })
    );

    const out = await delegate({ prompt: 'review', governed: false, meter: 'totals-only' });

    expect(out).toContain('reviewed');
    expect(out).toContain('metering total');
    expect(out).toContain('Metering Worker');
    expect(out).toMatch(/\$\d/); // a real price, not absent
  });

  it('honours the AIGENCY_METER env default when no meter arg is given', async () => {
    process.env.AIGENCY_METER = 'totals-only';
    setEnv('mtr-worker', 'https://worker.example/v1', 'sk-x');
    vi.stubGlobal(
      'fetch',
      fetchWithUsage('reviewed', { prompt_tokens: 1000, completion_tokens: 500 })
    );

    const out = await delegate({ prompt: 'review', governed: false });

    expect(out).toContain('metering total');
  });

  it('reports a legible note (not a $0 table) when the worker returns no usage', async () => {
    setEnv('mtr-worker', 'https://worker.example/v1', 'sk-x');
    vi.stubGlobal('fetch', fetchWithUsage('reviewed', undefined));

    const out = await delegate({ prompt: 'review', governed: false, meter: 'totals-only' });

    expect(out).toContain('reviewed');
    expect(out).toContain('no token usage');
    expect(out).not.toContain('metering total');
  });
});

describe('delegate — verify (antagonistic review on the reasoning tier)', () => {
  const REJECT: VerifyResult = {
    ok: false,
    findings: [{ kind: 'REVIEW', where: 'tests', message: 'no error-path coverage' }],
  };
  const APPROVE: VerifyResult = { ok: true, findings: [] };

  /** A reviewer factory returning a verifier scripted to a fixed verdict
   * sequence, with fixed accumulated usage. */
  function scriptedReviewer(
    verdicts: VerifyResult[],
    usage: PerModelUsage[] = [],
    model = 'fake-reasoner'
  ): () => Promise<Reviewer> {
    let i = 0;
    return async () => ({
      model,
      verifier: async () => verdicts[Math.min(i++, verdicts.length - 1)],
      usage: () => usage,
    });
  }

  const noReviewer = async () => null;
  /** A reviewer whose verify call throws (a transport blip), optionally after
   * recording usage — so the catch path's metering can be checked. */
  const throwingReviewer =
    (usage: PerModelUsage[] = []) =>
    async (): Promise<Reviewer> => ({
      model: 'fake-reasoner',
      verifier: async () => {
        throw new Error('reasoner 503');
      },
      usage: () => usage,
    });

  function userTurnOf(fetchMock: ReturnType<typeof okFetch>, call: number): string {
    const body = JSON.parse((fetchMock.mock.calls[call][1] as RequestInit).body as string);
    return body.messages.find((m: { role: string }) => m.role === 'user').content;
  }

  it('loops the worker on the review findings and returns the approved result with the verdict', async () => {
    setEnv('qwen2.5:7b');
    const fetchMock = okFetch('WORKER OUTPUT');
    vi.stubGlobal('fetch', fetchMock);

    const out = await delegate(
      { prompt: 'build the thing', governed: false, verify: true },
      undefined,
      undefined,
      scriptedReviewer([REJECT, APPROVE])
    );

    expect(fetchMock).toHaveBeenCalledTimes(2); // initial + one fix re-produce
    // the re-produce threads the worker's own previous output back in (fix, not
    // blind regenerate), the findings, and a demand for the corrected artifact
    // only — a smaller worker otherwise derails into discussing the feedback.
    const fix = userTurnOf(fetchMock, 1);
    expect(fix).toContain('WORKER OUTPUT');
    expect(fix).toContain('no error-path coverage');
    expect(fix).toContain('Output only the corrected');
    expect(out).toContain('WORKER OUTPUT');
    expect(out).toContain('reviewed on fake-reasoner (reasoning): approved after 2 attempt(s)');
  });

  it('returns a not-approved note with the findings when the review never passes', async () => {
    setEnv('qwen2.5:7b');
    const fetchMock = okFetch('WORKER OUTPUT');
    vi.stubGlobal('fetch', fetchMock);

    const out = await delegate(
      { prompt: 'p', governed: false, verify: true },
      undefined,
      undefined,
      scriptedReviewer([REJECT])
    );

    expect(fetchMock).toHaveBeenCalledTimes(3); // initial + 2 re-produces, then the cap
    expect(out).toContain('NOT approved after 3 attempt(s)');
    expect(out).toContain('no error-path coverage');
  });

  it('returns the worker output unreviewed with a note when no reasoning tier is configured', async () => {
    setEnv('qwen2.5:7b');
    const fetchMock = okFetch('WORKER OUTPUT');
    vi.stubGlobal('fetch', fetchMock);

    const out = await delegate(
      { prompt: 'p', governed: false, verify: true },
      undefined,
      undefined,
      noReviewer
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out).toContain('WORKER OUTPUT');
    expect(out).toContain('no reasoning-tier model is configured');
  });

  it('returns the transport message and never consults the reviewer when the worker is unreachable', async () => {
    setEnv('qwen2.5:7b');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      })
    );
    let reviewerCalled = false;
    const out = await delegate(
      { prompt: 'p', governed: false, verify: true },
      undefined,
      undefined,
      async () => {
        reviewerCalled = true;
        return null;
      }
    );
    expect(out).toContain('Could not reach the worker');
    expect(reviewerCalled).toBe(false); // a down worker is not a review failure
  });

  it('degrades to returning the work unreviewed when the reviewer call errors', async () => {
    setEnv('qwen2.5:7b');
    const fetchMock = okFetch('WORKER OUTPUT');
    vi.stubGlobal('fetch', fetchMock);

    const out = await delegate(
      { prompt: 'p', governed: false, verify: true },
      undefined,
      undefined,
      throwingReviewer()
    );

    expect(out).toContain('WORKER OUTPUT');
    expect(out).toContain('verify could not run');
  });

  it('meters the worker and the reviewer as separate model lines', async () => {
    delete process.env.AIGENCY_METER;
    registerModelCatalog([
      {
        provider: 'vrftest',
        family: 'vrf-worker',
        modelClass: 'extraction',
        currentId: 'vrf-worker',
        rates: [0.6, 1.5],
        label: 'Verify Worker',
        prefixes: ['vrf-worker'],
      },
      {
        provider: 'vrftest',
        family: 'vrf-reasoner',
        modelClass: 'reasoning',
        currentId: 'vrf-reasoner',
        rates: [3, 15],
        label: 'Verify Reasoner',
        prefixes: ['vrf-reasoner'],
      },
    ]);
    setEnv('vrf-worker', 'https://worker.example/v1', 'sk-x');
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: async () => ({
            choices: [{ message: { content: 'WORKER OUTPUT' } }],
            usage: { prompt_tokens: 800, completion_tokens: 200 },
          }),
        })
      )
    );

    const out = await delegate(
      { prompt: 'p', governed: false, verify: true, meter: 'totals-only' },
      undefined,
      undefined,
      scriptedReviewer([APPROVE], [roundUsage('vrf-reasoner', 500, 100)], 'vrf-reasoner')
    );

    expect(out).toContain('metering total');
    expect(out).toContain('Verify Worker'); // the worker model line
    expect(out).toContain('Verify Reasoner'); // the reviewer model line, separately metered
  });

  it('surfaces the first attempt and the outstanding findings when the worker dies on the fix re-produce — never an error stamped approved', async () => {
    setEnv('qwen2.5:7b');
    let n = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        n += 1;
        if (n === 1)
          return Promise.resolve({
            ok: true,
            json: async () => ({ choices: [{ message: { content: 'FIRST GOOD OUTPUT' } }] }),
          });
        throw new Error('ECONNREFUSED'); // the worker died trying to fix the findings
      })
    );

    const out = await delegate(
      { prompt: 'p', governed: false, verify: true },
      undefined,
      undefined,
      scriptedReviewer([REJECT]) // always rejects → forces a re-produce
    );

    expect(out).toContain('FIRST GOOD OUTPUT'); // the good first attempt, not the worker error
    expect(out).toContain('could not be re-run');
    expect(out).toContain('no error-path coverage'); // the outstanding findings, surfaced
    expect(out).not.toContain('approved after'); // a worker error is never stamped approved
  });

  it('never throws when the reviewer factory itself rejects — degrades to a legible note', async () => {
    setEnv('qwen2.5:7b');
    vi.stubGlobal('fetch', okFetch('WORKER OUTPUT'));

    const out = await delegate(
      { prompt: 'p', governed: false, verify: true },
      undefined,
      undefined,
      async () => {
        throw new Error('reasoner init boom');
      }
    );

    expect(out).toContain('WORKER OUTPUT');
    expect(out).toContain('verify could not run');
    expect(out).toContain('reasoner init boom');
  });

  it('keeps the reviewer usage on the meter when the reviewer errors mid-loop', async () => {
    delete process.env.AIGENCY_METER;
    registerModelCatalog([
      {
        provider: 'vrftest',
        family: 'vrf-worker',
        modelClass: 'extraction',
        currentId: 'vrf-worker',
        rates: [0.6, 1.5],
        label: 'Verify Worker',
        prefixes: ['vrf-worker'],
      },
      {
        provider: 'vrftest',
        family: 'vrf-reasoner',
        modelClass: 'reasoning',
        currentId: 'vrf-reasoner',
        rates: [3, 15],
        label: 'Verify Reasoner',
        prefixes: ['vrf-reasoner'],
      },
    ]);
    setEnv('vrf-worker', 'https://worker.example/v1', 'sk-x');
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: async () => ({
            choices: [{ message: { content: 'WORKER OUTPUT' } }],
            usage: { prompt_tokens: 800, completion_tokens: 200 },
          }),
        })
      )
    );

    const out = await delegate(
      { prompt: 'p', governed: false, verify: true, meter: 'totals-only' },
      undefined,
      undefined,
      throwingReviewer([roundUsage('vrf-reasoner', 300, 50)])
    );

    expect(out).toContain('verify could not run'); // the reviewer blew up
    expect(out).toContain('Verify Reasoner'); // but its already-incurred tokens are still metered
  });
});
