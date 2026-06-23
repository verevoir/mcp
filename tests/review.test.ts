// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ModelConnection } from '@verevoir/llm';
import { reasoningReviewer } from '../src/tools/review.js';

afterEach(() => vi.unstubAllGlobals());

const conn: ModelConnection = {
  provider: 'rtest',
  modelId: 'vrf-reasoner',
  baseUrl: 'https://reasoner.example/v1',
  apiKey: 'sk-r',
};

function okReply(content: string, usage?: unknown) {
  return vi.fn(() =>
    Promise.resolve({
      ok: true,
      json: async () => ({ choices: [{ message: { content } }], ...(usage ? { usage } : {}) }),
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

    const reviewer = await reasoningReviewer('code', async () => conn);
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
    const reviewer = await reasoningReviewer('code', async () => conn);
    const verdict = await reviewer!.verifier({
      capability: 'c',
      verify: 'adversarial-review',
      result: 'some code',
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.findings[0]).toMatchObject({ where: 'overflow' });
  });

  it('accumulates the review token usage under the reasoning model for metering', async () => {
    vi.stubGlobal('fetch', okReply('APPROVE', { prompt_tokens: 300, completion_tokens: 20 }));
    const reviewer = await reasoningReviewer('work', async () => conn);
    await reviewer!.verifier({ capability: 'c', verify: 'adversarial-review', result: 'x' });
    const usage = reviewer!.usage();
    expect(usage).toHaveLength(1);
    expect(usage[0]).toHaveProperty('vrf-reasoner');
  });

  it('throws on a non-ok reasoning response so the caller can degrade gracefully', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 503, text: async () => 'overloaded' }))
    );
    const reviewer = await reasoningReviewer('work', async () => conn);
    await expect(
      reviewer!.verifier({ capability: 'c', verify: 'adversarial-review', result: 'x' })
    ).rejects.toThrow(/HTTP 503/);
  });
});
