import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  delegate,
  workerConfig,
  workerSummary,
  resolveWorkerModel,
  clearWorkerModelsCache,
} from '../src/tools/delegate.js';

const ENV = ['AIGENCY_WORKER_URL', 'AIGENCY_WORKER_MODEL', 'AIGENCY_WORKER_API_KEY'];
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
