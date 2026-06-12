import { describe, it, expect, vi, afterEach } from 'vitest';
import { embeddingsConfig, fetchEmbedder } from '../src/embedder.js';

const ENV_KEYS = [
  'AIGENCY_EMBEDDINGS_API_KEY',
  'OPENAI_API_KEY',
  'AIGENCY_EMBEDDINGS_URL',
  'AIGENCY_EMBEDDINGS_MODEL',
];
const saved: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
});

describe('embeddingsConfig', () => {
  it('falls back to OPENAI_API_KEY and uses OpenAI defaults', () => {
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.OPENAI_API_KEY = 'sk-x';
    const c = embeddingsConfig();
    expect(c.apiKey).toBe('sk-x');
    expect(c.url).toContain('/embeddings');
    expect(c.model).toBe('text-embedding-3-small');
  });

  it('honours explicit overrides — any OpenAI-compatible provider', () => {
    process.env.AIGENCY_EMBEDDINGS_API_KEY = 'key';
    process.env.AIGENCY_EMBEDDINGS_URL = 'https://api.mistral.ai/v1/embeddings';
    process.env.AIGENCY_EMBEDDINGS_MODEL = 'mistral-embed';
    expect(embeddingsConfig()).toEqual({
      apiKey: 'key',
      url: 'https://api.mistral.ai/v1/embeddings',
      model: 'mistral-embed',
    });
  });
});

describe('fetchEmbedder', () => {
  it('returns null when no key is configured (caller degrades to practices-only)', () => {
    expect(fetchEmbedder({ apiKey: null, url: 'u', model: 'm' })).toBeNull();
  });

  it('embeds via the endpoint and orders vectors by the returned index', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: [
          { index: 1, embedding: [0, 1] },
          { index: 0, embedding: [1, 0] },
        ],
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const e = fetchEmbedder({ apiKey: 'k', url: 'https://x/embeddings', model: 'm' })!;
    expect(e.id).toBe('openai-compat:m');
    const vecs = await e.embed(['a', 'b']);
    expect(vecs).toEqual([
      [1, 0],
      [0, 1],
    ]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('throws a useful error on a non-ok response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 401, text: async () => 'bad key' }))
    );
    const e = fetchEmbedder({ apiKey: 'k', url: 'u', model: 'm' })!;
    await expect(e.embed(['a'])).rejects.toThrow(/401/);
  });

  it('short-circuits empty input without a network call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const e = fetchEmbedder({ apiKey: 'k', url: 'u', model: 'm' })!;
    expect(await e.embed([])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
