import { describe, it, expect } from 'vitest';
import type { ToolUse } from '@verevoir/llm';
import { makeExecutor, emptyLog, type DelegatedRun } from '../src/coordinator-cost/executor.js';
import type { enactCapability } from '../src/tools/enact.js';

// The executor's routing decisions ARE unit-testable via injected deps (no
// network). These pin the STDIO-521 fix: a coordinator's tier override routes to
// the right PROVIDER (up→opus, down→haiku, worker→DeepSeek) rather than through
// the worker-locked delegate that can only reach one provider — the bug that
// made every up/down delegation in the full run return 0 tokens and no output.

const use = (name: string, input: Record<string, unknown>): ToolUse => ({
  id: '1',
  name,
  input,
});

describe('executor — routes the coordinator tier by provider (STDIO-521)', () => {
  it('routes a delegate(model:opus) via runDelegated, by term — not the worker', async () => {
    const log = emptyLog();
    const seen: string[] = [];
    const runDelegatedFn = async (term: string): Promise<DelegatedRun> => {
      seen.push(term);
      return { text: `<ran on ${term}>`, usage: { [term]: { in: 10, out: 5 } }, model: term };
    };
    const exec = makeExecutor(log, { runDelegatedFn });

    const out = await exec(use('delegate', { prompt: 'the reasoning slice', model: 'opus' }));

    expect(seen).toEqual(['opus']); // routed UP to opus, by term
    expect(out).toContain('opus');
    expect(log.calls.some((c) => c.model === 'opus' && c.tokensIn === 10)).toBe(true);
  });

  it('routes a delegate(model:haiku) down to haiku', async () => {
    const log = emptyLog();
    const seen: string[] = [];
    const runDelegatedFn = async (term: string): Promise<DelegatedRun> => {
      seen.push(term);
      return { text: 'ok', usage: {}, model: term };
    };
    const exec = makeExecutor(log, { runDelegatedFn });
    await exec(use('dispatch', { prompt: 'light work', model: 'haiku' }));
    expect(seen).toEqual(['haiku']);
  });

  it('defaults a delegate with no override to the worker term', async () => {
    const log = emptyLog();
    const seen: string[] = [];
    const runDelegatedFn = async (term: string): Promise<DelegatedRun> => {
      seen.push(term);
      return { text: 'ok', usage: {}, model: term };
    };
    const exec = makeExecutor(log, { runDelegatedFn });
    await exec(use('delegate', { prompt: 'bulk, no tier named' }));
    // AIGENCY_WORKER_MODEL / extraction, else the 'haiku' default — either way a
    // non-empty worker term, never undefined.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeTruthy();
  });

  it('does NOT forward the coordinator tier override into enact (enact self-tiers)', async () => {
    const log = emptyLog();
    let enactModel: unknown = 'UNSET';
    const enact = (async (input: { model?: string }) => {
      enactModel = input.model;
      return 'TOKENS';
    }) as unknown as typeof enactCapability;
    const exec = makeExecutor(log, { enact });

    await exec(use('enact_capability', { capability: 'x', directive: 'y', model: 'opus' }));

    // The 'opus' override must be dropped — forwarding it would push the enact's
    // worker onto a provider that can't serve it (the full-run failure).
    expect(enactModel).toBeUndefined();
  });
});
