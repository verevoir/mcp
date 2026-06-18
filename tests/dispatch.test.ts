import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  dispatchTask,
  DISPATCH_TOOLS,
  makeDispatchExecutor,
  startDispatch,
  dispatchResult,
  formatJob,
  clearDispatchJobs,
} from '../src/tools/dispatch.js';

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
