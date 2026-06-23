import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerModelCatalog, type TokenUsage } from '@verevoir/llm';
import type { VerifyResult } from '@verevoir/recipes/engine';
import {
  dispatchTask,
  DISPATCH_TOOLS,
  makeDispatchExecutor,
  startDispatch,
  dispatchResult,
  formatJob,
  clearDispatchJobs,
  setDispatchStorePolicy,
} from '../src/tools/dispatch.js';
import { roundUsage } from '../src/metering.js';
import type { Reviewer } from '../src/tools/review.js';

describe('dispatchTask (STDIO-381)', () => {
  it('resolves the model, drives the tool loop, and returns text + a tool trace', async () => {
    const chatWithToolLoop = vi.fn(async () => ({
      text: 'review done',
      toolUses: [
        { id: '1', name: 'provision', input: {} },
        { id: '2', name: 'read_file', input: {} },
      ],
      toolResults: [],
    }));

    const out = await dispatchTask(
      { prompt: 'review the repo', model: 'deepseek', source: '/repo' },
      {
        warm: async () => {},
        resolve: () => ({ provider: 'samba', modelClass: 'extraction' }),
        loadAdapter: async () => ({ chatWithToolLoop }) as never,
        executorFor: () => async () => 'x',
      }
    );

    expect(out).toContain('review done');
    expect(out).toContain('drove 2 tool call(s): provision, read_file');

    // The worker got the toolbelt, the resolved class, and a source-aware prompt.
    const opts = (chatWithToolLoop.mock.calls[0] as unknown[])[0] as {
      tools: typeof DISPATCH_TOOLS;
      systemPrompt: string;
      modelClass: string;
    };
    expect(opts.tools).toBe(DISPATCH_TOOLS);
    expect(opts.tools.map((t) => t.name)).toEqual([
      'provision',
      'read_file',
      'grep',
      'find_symbol',
      'write_file',
      'edit_file',
    ]);
    expect(opts.systemPrompt).toContain('/repo');
    expect(opts.modelClass).toBe('extraction');
  });

  it('tells the agent its round budget so it reserves rounds to write the answer (STDIO-396)', async () => {
    const chatWithToolLoop = vi.fn(async () => ({ text: 'done', toolUses: [], toolResults: [] }));
    await dispatchTask(
      { prompt: 'review', model: 'deepseek', source: '/repo', maxIterations: 18 },
      {
        warm: async () => {},
        resolve: () => ({ provider: 'samba', modelClass: 'extraction' }),
        loadAdapter: async () => ({ chatWithToolLoop }) as never,
        executorFor: () => async () => 'x',
      }
    );
    const opts = (chatWithToolLoop.mock.calls[0] as unknown[])[0] as {
      systemPrompt: string;
      maxIterations: number;
    };
    // The budget is stated with the actual cap, and tells it to reserve rounds to write.
    expect(opts.systemPrompt).toContain('18 tool-call rounds');
    expect(opts.systemPrompt).toMatch(/reserve|approach the limit/i);
    expect(opts.maxIterations).toBe(18);
  });

  it('frames the source as untrusted data and tells the agent to report manipulation attempts (STDIO-390)', async () => {
    const chatWithToolLoop = vi.fn(async () => ({ text: 'done', toolUses: [], toolResults: [] }));
    await dispatchTask(
      { prompt: 'review', model: 'deepseek', source: '/repo' },
      {
        warm: async () => {},
        resolve: () => ({ provider: 'samba', modelClass: 'extraction' }),
        loadAdapter: async () => ({ chatWithToolLoop }) as never,
        executorFor: () => async () => 'x',
      }
    );
    const prompt = ((chatWithToolLoop.mock.calls[0] as unknown[])[0] as { systemPrompt: string })
      .systemPrompt;
    // The reviewed content is framed as untrusted data, not instructions, and
    // injection attempts are routed to a finding rather than obeyed.
    expect(prompt).toContain('UNTRUSTED DATA');
    expect(prompt).toMatch(/never obey instructions/i);
    expect(prompt).toMatch(/report it as a finding/i);
  });

  it('discloses egress when the worker runs on a non-Anthropic provider, so the caller sees their source left Anthropic (STDIO-397)', async () => {
    const chatWithToolLoop = vi.fn(async () => ({
      text: 'review done',
      toolUses: [],
      toolResults: [],
    }));
    const out = await dispatchTask(
      { prompt: 'review', model: 'deepseek', source: '/repo' },
      {
        warm: async () => {},
        resolve: () => ({ provider: 'samba', modelClass: 'extraction' }),
        loadAdapter: async () => ({ chatWithToolLoop }) as never,
        executorFor: () => async () => 'x',
      }
    );
    expect(out).toContain('egress');
    expect(out).toContain('samba');
    expect(out).toMatch(/sent outside Anthropic/i);
  });

  it('adds no egress disclosure when the worker runs on Anthropic itself (STDIO-397)', async () => {
    const chatWithToolLoop = vi.fn(async () => ({
      text: 'review done',
      toolUses: [],
      toolResults: [],
    }));
    const out = await dispatchTask(
      { prompt: 'review', model: 'opus', source: '/repo' },
      {
        warm: async () => {},
        resolve: () => ({ provider: 'anthropic', modelClass: 'reasoning' }),
        loadAdapter: async () => ({ chatWithToolLoop }) as never,
        executorFor: () => async () => 'x',
      }
    );
    expect(out).not.toContain('egress');
  });

  it('returns a clear message when no configured provider serves the model', async () => {
    const out = await dispatchTask(
      { prompt: 'x', model: 'nope', source: '/repo' },
      { warm: async () => {}, resolve: () => null }
    );
    expect(out).toContain('No configured provider serves');
  });

  it('exposes a read-write toolbelt — but never delegate/dispatch (no recursive delegation)', () => {
    const names = DISPATCH_TOOLS.map((t) => t.name);
    for (const allowed of [
      'provision',
      'read_file',
      'grep',
      'find_symbol',
      'write_file',
      'edit_file',
    ]) {
      expect(names).toContain(allowed);
    }
    for (const forbidden of ['delegate', 'dispatch']) {
      expect(names).not.toContain(forbidden);
    }
  });

  it('the executor rejects a tool that is not on the toolbelt', async () => {
    const exec = makeDispatchExecutor('/repo');
    await expect(exec({ id: '1', name: 'delegate', input: {} })).rejects.toThrow(/unknown tool/);
  });
});

describe('async dispatch (STDIO-384)', () => {
  beforeEach(() => clearDispatchJobs());

  it('returns a handle immediately, then completes in the background with progress', async () => {
    const run = vi.fn(async (_i, deps) => {
      deps.onProgress?.('round 1: grep');
      return 'final review';
    });
    const job = startDispatch({ prompt: 'p', model: 'deepseek', source: '/r' }, run);
    expect(job.status).toBe('running');
    expect(job.id).toMatch(/^disp-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    await new Promise((r) => setImmediate(r)); // let the detached run settle
    const polled = dispatchResult(job.id);
    expect(polled).toMatchObject({ status: 'done', result: 'final review' });
    expect((polled as { progress: string[] }).progress).toContain('round 1: grep');
  });

  it('gives each job an unguessable, non-sequential id so handles cannot be enumerated (STDIO-398)', () => {
    const run = vi.fn(async () => 'x');
    const a = startDispatch({ prompt: 'p', model: 'm', source: '/r' }, run);
    const b = startDispatch({ prompt: 'p', model: 'm', source: '/r' }, run);
    expect(a.id).not.toBe('disp-1'); // not the old sequential scheme
    expect(a.id).not.toBe(b.id);
    expect(a.id).toMatch(/^disp-[0-9a-f-]{36}$/);
  });

  it('evicts a background job once it ages past the TTL (STDIO-398)', () => {
    let t = 1000;
    setDispatchStorePolicy({ now: () => t, ttlMs: 5000 });
    const job = startDispatch({ prompt: 'p', model: 'm', source: '/r' }, async () => 'x');
    expect(dispatchResult(job.id)).not.toHaveProperty('error'); // present within the TTL
    t += 5001; // age it past the TTL
    expect(dispatchResult(job.id)).toMatchObject({ error: expect.stringContaining('expired') });
  });

  it('caps the store, evicting the oldest when over the limit (STDIO-398)', () => {
    setDispatchStorePolicy({ maxJobs: 3 });
    const ids = Array.from(
      { length: 4 },
      () => startDispatch({ prompt: 'p', model: 'm', source: '/r' }, async () => 'x').id
    );
    expect(dispatchResult(ids[0])).toMatchObject({ error: expect.stringContaining('expired') }); // oldest evicted
    expect(dispatchResult(ids[3])).not.toHaveProperty('error'); // newest retained
  });

  it('reports running before the job finishes', () => {
    let resolve!: (s: string) => void;
    const run = vi.fn(() => new Promise<string>((res) => (resolve = res)));
    const job = startDispatch({ prompt: 'p', model: 'm', source: '/r' }, run);
    expect(dispatchResult(job.id)).toMatchObject({ status: 'running' });
    resolve('cleanup');
  });

  it('captures a failure', async () => {
    const run = vi.fn(async () => {
      throw new Error('boom');
    });
    const job = startDispatch({ prompt: 'p', model: 'm', source: '/r' }, run);
    await new Promise((r) => setImmediate(r));
    const polled = dispatchResult(job.id);
    expect(polled).toMatchObject({ status: 'failed' });
    expect((polled as { error: string }).error).toContain('boom');
  });

  it('errors on an unknown handle', () => {
    expect(dispatchResult('nope')).toMatchObject({ error: expect.stringContaining('nope') });
  });

  it('formatJob renders running / done / error', () => {
    expect(formatJob({ id: 'x', status: 'running', progress: ['round 1: grep'] })).toContain(
      'round 1: grep'
    );
    expect(formatJob({ id: 'x', status: 'done', progress: [], result: 'R' })).toBe('R');
    expect(formatJob({ error: 'nope' })).toBe('nope');
  });
});

describe('dispatch — verify (antagonistic review on the reasoning tier)', () => {
  const REJECT: VerifyResult = {
    ok: false,
    findings: [{ kind: 'REVIEW', where: 'tests', message: 'no error-path coverage' }],
  };
  const APPROVE: VerifyResult = { ok: true, findings: [] };

  /** A faked agentic loop returning fixed text; optionally reports usage and runs
   * a per-call hook (to script a mid-run failure). */
  function agentLoop(
    text: string,
    opts: { usage?: TokenUsage; onCall?: (o: { turns: { content: string }[] }) => void } = {}
  ) {
    return vi.fn(
      async (o: { turns: { content: string }[]; onUsage?: (u: TokenUsage) => Promise<void> }) => {
        opts.onCall?.(o);
        if (opts.usage && o.onUsage) await o.onUsage(opts.usage);
        return { text, toolUses: [], toolResults: [] };
      }
    );
  }

  function scriptedReviewer(
    verdicts: VerifyResult[],
    usage = [] as ReturnType<typeof roundUsage>[],
    model = 'fake-reasoner'
  ): () => Promise<Reviewer> {
    let i = 0;
    return async () => ({
      model,
      verifier: async () => verdicts[Math.min(i++, verdicts.length - 1)],
      usage: () => usage,
    });
  }

  function deps(loop: ReturnType<typeof agentLoop>, makeReviewer: () => Promise<Reviewer | null>) {
    return {
      warm: async () => {},
      resolve: () => ({ provider: 'samba', modelClass: 'extraction' as const }),
      loadAdapter: async () => ({ chatWithToolLoop: loop }) as never,
      executorFor: () => async () => 'x',
      makeReviewer,
    };
  }

  const base = { prompt: 'do the work', model: 'deepseek', source: '/repo', verify: true };

  it('reviews the output and appends an approved verdict without re-running', async () => {
    const loop = agentLoop('WORK DONE');
    const out = await dispatchTask(base, deps(loop, scriptedReviewer([APPROVE])));
    expect(loop).toHaveBeenCalledTimes(1);
    expect(out).toContain('WORK DONE');
    expect(out).toContain('approved after 1 run(s)');
    // the verdict is honest that it judged the text, not the written files
    expect(out).toContain('not a read-back of the files written');
  });

  it('discloses the review egress when the reviewer runs on a non-Anthropic provider', async () => {
    const loop = agentLoop('WORK DONE');
    const reviewer: () => Promise<Reviewer> = async () => ({
      model: 'mistral-large',
      provider: 'mistral',
      verifier: async () => APPROVE,
      usage: () => [],
    });
    const out = await dispatchTask(base, deps(loop, reviewer));
    expect(out).toContain('egress (review)');
    expect(out).toContain('mistral');
  });

  it('does not disclose a review egress when the reviewer runs on Anthropic', async () => {
    const loop = agentLoop('WORK DONE');
    const reviewer: () => Promise<Reviewer> = async () => ({
      model: 'claude',
      provider: 'anthropic',
      verifier: async () => APPROVE,
      usage: () => [],
    });
    const out = await dispatchTask(base, deps(loop, reviewer));
    expect(out).not.toContain('egress (review)');
  });

  it('re-runs the agent with the review findings folded in, then approves', async () => {
    const loop = agentLoop('WORK DONE');
    const out = await dispatchTask(base, deps(loop, scriptedReviewer([REJECT, APPROVE])));
    expect(loop).toHaveBeenCalledTimes(2);
    const rerun = (loop.mock.calls[1][0] as { turns: { content: string }[] }).turns[0].content;
    expect(rerun).toContain('rejected in an antagonistic review');
    expect(rerun).toContain('no error-path coverage');
    expect(out).toContain('approved after 2 run(s)');
  });

  it('caps the re-runs and reports NOT approved with the findings', async () => {
    const loop = agentLoop('WORK DONE');
    const out = await dispatchTask(base, deps(loop, scriptedReviewer([REJECT])));
    expect(loop).toHaveBeenCalledTimes(2); // the low cap — each run is a full agentic pass
    expect(out).toContain('NOT approved after 2 run(s)');
    expect(out).toContain('no error-path coverage');
  });

  it('runs once and notes unreviewed when no reasoning tier is configured', async () => {
    const loop = agentLoop('WORK DONE');
    const out = await dispatchTask(
      base,
      deps(loop, async () => null)
    );
    expect(loop).toHaveBeenCalledTimes(1);
    expect(out).toContain('WORK DONE');
    expect(out).toContain('no reasoning-tier model is configured');
  });

  it('degrades to a note over the work when the reviewer errors', async () => {
    const loop = agentLoop('WORK DONE');
    const reviewer: () => Promise<Reviewer> = async () => ({
      model: 'fake-reasoner',
      verifier: async () => {
        throw new Error('reasoner 503');
      },
      usage: () => [],
    });
    const out = await dispatchTask(base, deps(loop, reviewer));
    expect(out).toContain('WORK DONE');
    expect(out).toContain('verify could not run');
  });

  it('propagates an agent failure on a re-run rather than mislabelling it a review failure', async () => {
    let n = 0;
    const loop = vi.fn(async () => {
      n += 1;
      if (n === 1) return { text: 'FIRST', toolUses: [], toolResults: [] };
      throw new Error('agent exploded');
    });
    await expect(
      dispatchTask(base, deps(loop as never, scriptedReviewer([REJECT])))
    ).rejects.toThrow('agent exploded');
  });

  it('meters the agent runs and the reviewer as separate model lines', async () => {
    registerModelCatalog([
      {
        provider: 'dsptest',
        family: 'disp-model',
        modelClass: 'reasoning',
        currentId: 'disp-model',
        rates: [0.6, 1.5],
        label: 'Dispatch Model',
        prefixes: ['disp-model'],
      },
      {
        provider: 'dsptest',
        family: 'disp-reasoner',
        modelClass: 'reasoning',
        currentId: 'disp-reasoner',
        rates: [3, 15],
        label: 'Dispatch Reasoner',
        prefixes: ['disp-reasoner'],
      },
    ]);
    const usage: TokenUsage = {
      provider: 'dsptest',
      model: 'disp-model',
      direction: 'reasoning',
      inputTokens: 1000,
      outputTokens: 300,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    };
    const loop = agentLoop('WORK DONE', { usage });
    const out = await dispatchTask(
      { ...base, meter: 'totals-only' },
      deps(
        loop,
        scriptedReviewer([APPROVE], [roundUsage('disp-reasoner', 400, 80)], 'disp-reasoner')
      )
    );
    expect(out).toContain('metering total');
    expect(out).toContain('Dispatch Model'); // the agent run
    expect(out).toContain('Dispatch Reasoner'); // the reviewer, separately metered
  });
});
