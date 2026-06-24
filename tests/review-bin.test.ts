// @vitest-environment node
import { describe, it, expect } from 'vitest';
import type { ModelClass, ModelConnection } from '@verevoir/llm';
import {
  parseArgs,
  assembleChange,
  describeChange,
  formatVerdict,
  run,
  EXIT,
  type GatherResult,
} from '../src/review-bin.js';

const conn: ModelConnection = {
  provider: 'rtest',
  modelId: 'vrf-reasoner',
  baseUrl: 'https://reasoner.example/v1',
  apiKey: 'sk-r',
};

describe('parseArgs', () => {
  it('defaults base to origin/main and head to HEAD', () => {
    expect(parseArgs([])).toEqual({ base: 'origin/main', head: 'HEAD' });
  });

  it('reads --base and --head as separate tokens', () => {
    expect(parseArgs(['--base', 'main', '--head', 'feature'])).toEqual({
      base: 'main',
      head: 'feature',
    });
  });

  it('reads --flag=value form', () => {
    expect(parseArgs(['--base=v1.0', '--head=v1.1'])).toEqual({ base: 'v1.0', head: 'v1.1' });
  });
});

describe('assembleChange', () => {
  it('includes the stat summary and the unified diff in a reviewable change', () => {
    const result = assembleChange(' file.ts | 2 +-', '@@ -1 +1 @@\n-old\n+new');
    expect(result.kind).toBe('change');
    const text = result.kind === 'change' ? result.change : '';
    expect(text).toContain('file.ts | 2 +-');
    expect(text).toContain('+new');
  });

  it('signals oversize (does NOT truncate) when the diff exceeds the cap', () => {
    const huge = 'x'.repeat(2000);
    const result = assembleChange('', huge, 500);
    expect(result).toMatchObject({ kind: 'oversize', cap: 500 });
    expect(result.kind === 'oversize' && result.bytes).toBeGreaterThan(500);
  });
});

describe('describeChange', () => {
  it('lists the commit subjects as the prose to provision against', () => {
    const desc = describeChange('add health endpoint\nfix overflow');
    expect(desc).toContain('- add health endpoint');
    expect(desc).toContain('- fix overflow');
  });

  it('falls back to a generic line when the range has no commits', () => {
    expect(describeChange('   \n  ')).toMatch(/no commit subjects/);
  });
});

describe('formatVerdict', () => {
  it('reports APPROVE on a clean verdict', () => {
    expect(formatVerdict({ ok: true, findings: [] })).toMatch(/^APPROVE/);
  });

  it('lists the findings on a rejection', () => {
    const text = formatVerdict({
      ok: false,
      findings: [{ kind: 'overflow', where: 'overflow', message: 'add() overflows with no test' }],
    });
    expect(text).toMatch(/^REJECT/);
    expect(text).toContain('overflow: add() overflows with no test');
  });
});

// The fail-closed wiring: a gate that can't run must EXIT 2, never silently
// pass. Deps are injected so the decision is tested without a live model.
describe('run — fail-closed wiring', () => {
  const nullTier = async (_t: ModelClass) => null;
  const okTier = async (_t: ModelClass) => conn;
  const gather = (): GatherResult => ({
    kind: 'change',
    change: 'diff',
    description: 'a change',
  });

  it('exits 2 when no reasoning tier is configured', async () => {
    let msg = '';
    const code = await run([], '/repo', (s) => (msg = s), { tier: nullTier, gather });
    expect(code).toBe(EXIT.cannotRun);
    expect(msg).toContain('no reasoning tier');
  });

  it('exits 0 without a reasoning call when the range is empty', async () => {
    let msg = '';
    // nullTier would force exit 2 if the empty short-circuit didn't precede it.
    const code = await run([], '/repo', (s) => (msg = s), {
      tier: nullTier,
      gather: () => ({ kind: 'empty' }),
    });
    expect(code).toBe(EXIT.clean);
    expect(msg).toContain('nothing to review');
  });

  it('exits 2 (fails closed) on an oversize diff rather than reviewing a prefix', async () => {
    let msg = '';
    const code = await run([], '/repo', (s) => (msg = s), {
      tier: okTier,
      gather: () => ({ kind: 'oversize', bytes: 900_000, cap: 524_288 }),
    });
    expect(code).toBe(EXIT.cannotRun);
    expect(msg).toContain('exceeds the 524288-byte review cap');
    expect(msg).toContain('NOT reviewed');
  });

  it('exits 2 when the rubric cannot be loaded', async () => {
    let msg = '';
    const code = await run([], '/repo', (s) => (msg = s), {
      tier: okTier,
      gather,
      provision: async () => null,
    });
    expect(code).toBe(EXIT.cannotRun);
    expect(msg).toContain('could not load the corpus rubric');
  });

  it('exits 2 when the git diff cannot be read', async () => {
    let msg = '';
    const code = await run([], '/repo', (s) => (msg = s), {
      tier: okTier,
      gather: () => {
        throw new Error('not a git repository');
      },
    });
    expect(code).toBe(EXIT.cannotRun);
    expect(msg).toContain('could not read the git diff');
  });

  type MakeReviewer = NonNullable<Parameters<typeof run>[3]>['makeReviewer'];

  // A reviewer fake that asserts it was handed the provisioned rubric and the
  // assembled change, then returns a fixed verdict.
  const reviewerReturning = (ok: boolean): MakeReviewer =>
    (async (_artefact, _tier, rubric) => {
      expect(rubric).toBe('THE RUBRIC');
      return {
        model: 'vrf-reasoner',
        usage: () => [],
        verifier: async (input) => {
          expect(input.result).toBe('diff');
          return ok
            ? { ok: true, findings: [] }
            : { ok: false, findings: [{ kind: 'x', message: 'bad' }] };
        },
      };
    }) as MakeReviewer;

  const base = { tier: okTier, gather, provision: async () => 'THE RUBRIC' };

  it('exits 0 on a clean verdict, passing the rubric and the change through to the reviewer', async () => {
    const code = await run([], '/repo', () => {}, {
      ...base,
      makeReviewer: reviewerReturning(true),
    });
    expect(code).toBe(EXIT.clean);
  });

  it('exits 1 when the reviewer returns findings', async () => {
    const code = await run([], '/repo', () => {}, {
      ...base,
      makeReviewer: reviewerReturning(false),
    });
    expect(code).toBe(EXIT.findings);
  });

  it('exits 2 when the reviewer resolves to null (reasoner unavailable)', async () => {
    let msg = '';
    const code = await run([], '/repo', (s) => (msg = s), {
      ...base,
      makeReviewer: (async () => null) as MakeReviewer,
    });
    expect(code).toBe(EXIT.cannotRun);
    expect(msg).toContain('reasoning reviewer unavailable');
  });

  it('does NOT resolve to 0 when the review errors mid-flight — it rejects so the bin fails closed', async () => {
    const erroring = (async (_artefact, _tier, _rubric) => ({
      model: 'vrf-reasoner',
      usage: () => [],
      verifier: async () => {
        throw new Error('reasoning model HTTP 503');
      },
    })) as MakeReviewer;
    // run() lets the rejection propagate; the bin's top-level .catch maps it to
    // exit 2. The fail-closed assertion is that it is NOT a 0 (approval).
    await expect(run([], '/repo', () => {}, { ...base, makeReviewer: erroring })).rejects.toThrow(
      /503/
    );
  });
});
