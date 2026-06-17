import { describe, it, expect, vi } from 'vitest';
import { dispatchTask, DISPATCH_TOOLS, makeDispatchExecutor } from '../src/tools/dispatch.js';

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
