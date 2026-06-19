import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  runRefine,
  runLoopSearch,
  evaluatorFor,
  resolveSeeds,
  refineStepPrompt,
  startRefine,
  startLoopSearch,
  loopResult,
  formatLoopJob,
  clearLoopJobs,
  setLoopStorePolicy,
  type StepCall,
} from '../src/tools/loop.js';
import type { RefineResult } from '../src/loop/refine.js';

// The tool layer wires the worker step + chosen eval into the pure family. These
// tests inject a fake `stepCall` (no model) and use the deterministic eval, so
// they exercise the wiring and the background-job lifecycle without a network.

/** A fake worker step: returns whatever the prompt last asked the worker to beat,
 * climbing toward "DONE" so a `output.includes('DONE')` metric eventually passes.
 * Here we keep it simpler — it returns a fixed reply, and the eval decides. */
function fixedStep(reply: string): StepCall {
  return vi.fn(async () => reply);
}

describe('evaluatorFor — config validation', () => {
  it("rejects a 'judge' choice with no rubric", () => {
    expect(() => evaluatorFor({ kind: 'judge' })).toThrow(/rubric/);
  });

  it("rejects a 'practices' choice with no workDescription", () => {
    expect(() => evaluatorFor({ kind: 'practices' })).toThrow(/workDescription/);
  });

  it("rejects a 'deterministic' choice with no expression", () => {
    expect(() => evaluatorFor({ kind: 'deterministic' })).toThrow(/expression/);
  });

  it('builds a deterministic evaluator from an inline expression', async () => {
    const ev = evaluatorFor({
      kind: 'deterministic',
      expression: "output.includes('DONE') ? 1 : 0",
    });
    expect(await ev('all DONE')).toEqual({ score: 1 });
    expect(await ev('not yet')).toEqual({ score: 0 });
  });

  it('scores a malformed expression as 0 with legible feedback rather than throwing', async () => {
    const ev = evaluatorFor({ kind: 'deterministic', expression: 'output.(' });
    const r = await ev('x');
    expect(r.score).toBe(0);
    expect(r.feedback).toContain('invalid deterministic expression');
  });
});

describe('refineStepPrompt', () => {
  it('asks for a first attempt when there is no previous one', () => {
    expect(refineStepPrompt('write a haiku')).toContain('write a haiku');
    expect(refineStepPrompt('write a haiku')).not.toContain('PREVIOUS');
  });

  it('threads the previous attempt and its feedback into the next prompt', () => {
    const p = refineStepPrompt('write a haiku', {
      output: 'old haiku',
      score: 0.4,
      feedback: 'wrong syllable count',
    });
    expect(p).toContain('old haiku');
    expect(p).toContain('wrong syllable count');
    expect(p).toContain('0.40');
  });
});

describe('resolveSeeds', () => {
  it('uses the explicit seed list when given', () => {
    expect(
      resolveSeeds({ task: 't', eval: { kind: 'judge' }, stop: { maxLoops: 1 }, seeds: ['a', 'b'] })
    ).toEqual(['a', 'b']);
  });

  it('generates `seedCount` distinct approach hints when no list is given', () => {
    const seeds = resolveSeeds({
      task: 't',
      eval: { kind: 'judge' },
      stop: { maxLoops: 1 },
      seedCount: 3,
    });
    expect(seeds).toHaveLength(3);
    expect(new Set(seeds).size).toBe(3); // distinct
  });

  it('defaults to three seeds when neither seeds nor seedCount is given', () => {
    expect(
      resolveSeeds({ task: 't', eval: { kind: 'judge' }, stop: { maxLoops: 1 } })
    ).toHaveLength(3);
  });
});

describe('runRefine (tool wiring, deterministic eval, fake worker)', () => {
  it('drives the worker step and scores each attempt with the chosen eval', async () => {
    const step = fixedStep('the answer is DONE');
    const result = await runRefine(
      {
        task: 'finish the task',
        eval: { kind: 'deterministic', expression: "output.includes('DONE') ? 1 : 0" },
        stop: { maxLoops: 3, targetScore: 1 },
      },
      step
    );
    expect(result.best.score).toBe(1);
    expect(result.stoppedBy).toBe('target');
    expect(step).toHaveBeenCalled();
  });
});

describe('runLoopSearch (tool wiring)', () => {
  it('runs each seed through the worker step and returns the best plus every seed run', async () => {
    // The worker echoes the seed hint, so a seed-specific metric picks a winner.
    const step: StepCall = vi.fn(async ({ prompt }) =>
      prompt.includes('robust') ? 'WIN' : 'lose'
    );
    const result = await runLoopSearch(
      {
        task: 'solve it',
        eval: { kind: 'deterministic', expression: "output === 'WIN' ? 1 : 0" },
        stop: { maxLoops: 1 },
        seeds: ['be direct', 'be robust', 'be fast'],
      },
      step
    );
    expect(result.best.result.best.score).toBe(1);
    expect(result.best.seed).toBe('be robust');
    expect(result.seedRuns).toHaveLength(3);
  });
});

describe('async loop jobs (mirrors dispatch, STDIO-398)', () => {
  beforeEach(() => clearLoopJobs());

  it('returns a handle immediately, then completes in the background', async () => {
    const fakeResult: RefineResult<string> = {
      best: { output: 'best', score: 0.9, iteration: 1 },
      trace: [{ iteration: 1, score: 0.9 }],
      stoppedBy: 'maxLoops',
    };
    const job = startRefine(
      { task: 't', eval: { kind: 'judge', rubric: 'r' }, stop: { maxLoops: 1 } },
      async () => fakeResult
    );
    expect(job.status).toBe('running');

    await new Promise((r) => setImmediate(r));
    const polled = loopResult(job.id);
    expect(polled).toMatchObject({ status: 'done' });
    expect((polled as { result: string }).result).toContain('best');
  });

  it('gives each job an unguessable, non-sequential handle so handles cannot be enumerated', () => {
    const a = startRefine(
      { task: 't', eval: { kind: 'judge', rubric: 'r' }, stop: { maxLoops: 1 } },
      async () => ({
        best: { output: 'x', score: 1, iteration: 1 },
        trace: [],
        stoppedBy: 'maxLoops',
      })
    );
    const b = startLoopSearch(
      { task: 't', eval: { kind: 'judge', rubric: 'r' }, stop: { maxLoops: 1 } },
      async () => ({
        best: {
          seed: 's',
          index: 0,
          result: {
            best: { output: 'x', score: 1, iteration: 1 },
            trace: [],
            stoppedBy: 'maxLoops',
          },
        },
        seedRuns: [],
      })
    );
    expect(a.id).not.toBe('loop-1');
    expect(a.id).not.toBe(b.id);
    expect(a.id).toMatch(/^loop-[0-9a-f-]{36}$/);
  });

  it('rejects an unknown / guessed handle', () => {
    expect(loopResult('loop-guessed')).toMatchObject({
      error: expect.stringContaining('loop-guessed'),
    });
  });

  it('evicts a job once it ages past the TTL', () => {
    let t = 1000;
    setLoopStorePolicy({ now: () => t, ttlMs: 5000 });
    const job = startRefine(
      { task: 't', eval: { kind: 'judge', rubric: 'r' }, stop: { maxLoops: 1 } },
      async () => ({
        best: { output: 'x', score: 1, iteration: 1 },
        trace: [],
        stoppedBy: 'maxLoops',
      })
    );
    expect(loopResult(job.id)).not.toHaveProperty('error');
    t += 5001;
    expect(loopResult(job.id)).toMatchObject({ error: expect.stringContaining('expired') });
  });

  it('captures a failure from the background run', async () => {
    const job = startRefine(
      { task: 't', eval: { kind: 'judge', rubric: 'r' }, stop: { maxLoops: 1 } },
      async () => {
        throw new Error('boom');
      }
    );
    await new Promise((r) => setImmediate(r));
    expect(loopResult(job.id)).toMatchObject({ status: 'failed' });
    expect((loopResult(job.id) as { error: string }).error).toContain('boom');
  });

  it('formatLoopJob renders running / done / not-found', () => {
    expect(formatLoopJob({ id: 'x', kind: 'refine', status: 'running' })).toContain('running');
    expect(formatLoopJob({ id: 'x', kind: 'refine', status: 'done', result: 'R' })).toBe('R');
    expect(formatLoopJob({ error: 'nope' })).toBe('nope');
  });
});
