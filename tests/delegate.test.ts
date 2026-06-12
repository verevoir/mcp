import { describe, it, expect, vi, afterEach } from 'vitest';
import { delegate, workerConfig } from '../src/tools/delegate.js';

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
  return vi.fn(async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] }),
  }));
}

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

describe('delegate', () => {
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

    const out = await delegate({ prompt: 'summarise X', system: 'be terse' });

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

    await delegate({ prompt: 'p', model: 'override-model' });

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
    const out = await delegate({ prompt: 'p' });
    expect(out).toContain('Could not reach the worker');
    expect(out).toContain('ollama serve');
  });

  it('surfaces a non-ok HTTP status from the worker', async () => {
    setEnv('qwen2.5:7b');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 404, text: async () => 'model not found' }))
    );
    const out = await delegate({ prompt: 'p' });
    expect(out).toContain('HTTP 404');
    expect(out).toContain('model not found');
  });
});
