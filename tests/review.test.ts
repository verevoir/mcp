// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { TierChat } from '../src/tiers.js';
import { reasoningReviewer } from '../src/tools/review.js';

afterEach(() => vi.unstubAllGlobals());

// A TierChat that drives a real (stubbed) fetch via the direct-compat path.
// We simulate a direct-URI tier by wrapping a fetch-based ChatFn.
function makeFetchBackedTier(
  fetchFn: typeof fetch,
  modelId = 'vrf-reasoner',
  baseUrl = 'https://reasoner.example/v1',
  apiKey: string | null = 'sk-r'
): TierChat {
  return {
    modelId,
    provider: 'rtest',
    chat: async (opts) => {
      const messages = [
        { role: 'system', content: opts.systemPrompt },
        ...opts.turns.map((t) => ({
          role: t.role,
          content: typeof t.content === 'string' ? t.content : JSON.stringify(t.content),
        })),
      ];
      const res = await fetchFn(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({ model: modelId, messages }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`reasoning model HTTP ${res.status} (${modelId}): ${body.slice(0, 160)}`);
      }
      const json = (await res.json().catch(() => null)) as {
        choices?: { message?: { content?: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      } | null;
      const content = json?.choices?.[0]?.message?.content;
      if (!content) throw new Error(`reasoning model returned no content (${modelId})`);
      return {
        content,
        usage: {
          provider: 'rtest',
          model: modelId,
          direction: 'reasoning' as const,
          inputTokens: json?.usage?.prompt_tokens ?? 0,
          outputTokens: json?.usage?.completion_tokens ?? 0,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        },
        stopReason: 'end_turn',
      };
    },
  };
}

function okReply(content: string, usage?: unknown) {
  return vi.fn(() =>
    Promise.resolve({
      ok: true,
      json: async () => ({ choices: [{ message: { content } }], ...(usage ? { usage } : {}) }),
      text: async () => '',
    })
  );
}

describe('reasoningReviewer', () => {
  it('returns null when no reasoning tier is configured', async () => {
    const r = await reasoningReviewer('work', async () => null);
    expect(r).toBeNull();
  });

  it('reviews on the reasoning model and reports a clean pass on APPROVE', async () => {
    const fetchMock = okReply('APPROVE', { prompt_tokens: 300, completion_tokens: 20 });
    vi.stubGlobal('fetch', fetchMock);

    const tier: TierChat = makeFetchBackedTier(fetchMock as unknown as typeof fetch);
    const reviewer = await reasoningReviewer('code', async () => tier);
    const verdict = await reviewer!.verifier({
      capability: 'write-module',
      verify: 'adversarial-review',
      result: 'export const add = (a, b) => a + b;',
    });

    expect(verdict).toEqual({ ok: true, findings: [] });
    // posted to the reasoning connection, antagonist system + the work as user data
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://reasoner.example/v1/chat/completions');
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('vrf-reasoner');
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[1].content).toContain('export const add');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-r');
  });

  it('blocks with the reviewer findings when it rejects', async () => {
    vi.stubGlobal('fetch', okReply('- overflow: add() overflows and has no test'));
    const fetchMock = okReply('- overflow: add() overflows and has no test');
    const tier = makeFetchBackedTier(fetchMock as unknown as typeof fetch);
    const reviewer = await reasoningReviewer('code', async () => tier);
    const verdict = await reviewer!.verifier({
      capability: 'c',
      verify: 'adversarial-review',
      result: 'some code',
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.findings[0]).toMatchObject({ where: 'overflow' });
  });

  it('accumulates the review token usage under the reasoning model for metering', async () => {
    const fetchMock = okReply('APPROVE', { prompt_tokens: 300, completion_tokens: 20 });
    vi.stubGlobal('fetch', fetchMock);
    const tier = makeFetchBackedTier(fetchMock as unknown as typeof fetch);
    const reviewer = await reasoningReviewer('work', async () => tier);
    await reviewer!.verifier({ capability: 'c', verify: 'adversarial-review', result: 'x' });
    const usage = reviewer!.usage();
    expect(usage).toHaveLength(1);
    expect(usage[0]).toHaveProperty('vrf-reasoner');
  });

  it('throws on a non-ok reasoning response so the caller can degrade gracefully', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 503,
      text: async () => 'overloaded',
    }));
    vi.stubGlobal('fetch', fetchMock);
    const tier = makeFetchBackedTier(fetchMock as unknown as typeof fetch);
    const reviewer = await reasoningReviewer('work', async () => tier);
    await expect(
      reviewer!.verifier({ capability: 'c', verify: 'adversarial-review', result: 'x' })
    ).rejects.toThrow(/HTTP 503/);
  });
});
