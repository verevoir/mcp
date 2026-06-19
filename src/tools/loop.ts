import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { jsonText } from '../result.js';
import { delegate } from './delegate.js';
import { provisionFrame } from './provision.js';
import {
  deterministicEval,
  modelJudgeEval,
  practicesAsBarEval,
  type Evaluator,
  type JudgeCall,
} from '../loop/evals.js';
import { runRefineLoop, type RefineResult, type StopPolicy } from '../loop/refine.js';
import { runSearch, type SearchResult } from '../loop/search.js';

// LOOP TOOLS (STDIO-430) — the async MCP surface over the refine/search family.
//
// The pure primitives (../loop/*) carry no MCP/server import, so the family
// extracts cleanly later. THIS file is the only place they meet the server: it
// wires `step` to a worker-model call (via `delegate`), picks the eval from the
// caller's choice, and runs the loop in a background job exactly the way
// `dispatch_start`/`dispatch_result` do — kick off detached, return an
// unguessable handle, poll by handle. A long refine/search run is bounded by no
// single request timeout that way.

// ── Eval selection ──────────────────────────────────────────────────────────
// The caller picks one eval and supplies its config. The model-backed evals run
// on the worker via `delegate` (governed:false — the judge scores, it isn't
// itself work to be held to a bar), which keeps the eval honest about cost and
// reuses the one worker connector.

/** The judge's model call: a single-shot worker call, ungoverned. Reuses the
 * `delegate` machinery so the judge runs on the same configured worker. */
function judgeCall(): JudgeCall {
  return ({ prompt, system, model }) => delegate({ prompt, system, model, governed: false });
}

const EVAL_KINDS = ['deterministic', 'judge', 'practices'] as const;
export type EvalKind = (typeof EVAL_KINDS)[number];

/** Config for the chosen eval. Only the fields the chosen `kind` needs are read;
 * the others are ignored — validated at the tool boundary below. */
export interface EvalChoice {
  kind: EvalKind;
  /** `judge`: the rubric to score against. */
  rubric?: string;
  /** `practices`: the work description to provision the bar from. */
  workDescription?: string;
  /** Worker model for the judge (model-backed evals only). */
  judgeModel?: string;
  /** `deterministic`: a JS expression body scoring `output` (a string) to a
   * number — see {@link deterministicScorerFromExpression}. Sandboxed-ish:
   * evaluated as a pure function of `output`, no closure over server state. */
  expression?: string;
}

/**
 * Build a deterministic scorer from a caller-supplied expression. The expression
 * is the BODY of `(output) => <expression>` and must return a number. This is
 * the escape hatch for "score by a metric I can express inline" without a model
 * — e.g. `output.includes("DONE") ? 1 : 0`. It sees ONLY `output`; it cannot
 * reach server state. A malformed expression scores 0 with the error as feedback
 * (failure legibility), rather than throwing and killing the loop.
 */
export function deterministicScorerFromExpression(expression: string): Evaluator<string> {
  let scorer: (output: string) => unknown;
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    scorer = new Function('output', `return (${expression});`) as (output: string) => unknown;
  } catch (err) {
    const message = String(err);
    return deterministicEval<string>(() => ({
      score: 0,
      feedback: `invalid deterministic expression: ${message}`,
    }));
  }
  return deterministicEval<string>((output) => {
    try {
      const value = scorer(output);
      const n = Number(value);
      return Number.isFinite(n) ? n : { score: 0, feedback: 'expression did not return a number' };
    } catch (err) {
      return { score: 0, feedback: `deterministic expression threw: ${String(err)}` };
    }
  });
}

/**
 * Resolve an {@link EvalChoice} into an Evaluator over string outputs (the worker
 * step produces text). The model-backed evals close over the worker `delegate`
 * call and `provisionFrame`. Throws a clear message when the choice is missing a
 * field its kind requires — validated before the loop starts so a bad config
 * fails fast and legibly rather than mid-run.
 */
export function evaluatorFor(choice: EvalChoice): Evaluator<string> {
  switch (choice.kind) {
    case 'deterministic':
      if (!choice.expression) {
        throw new Error("eval kind 'deterministic' requires an `expression` to score with");
      }
      return deterministicScorerFromExpression(choice.expression);
    case 'judge':
      if (!choice.rubric) {
        throw new Error("eval kind 'judge' requires a `rubric` to score against");
      }
      return modelJudgeEval<string>({
        rubric: choice.rubric,
        model: choice.judgeModel,
        call: judgeCall(),
      });
    case 'practices':
      if (!choice.workDescription) {
        throw new Error("eval kind 'practices' requires a `workDescription` to provision the bar");
      }
      return practicesAsBarEval<string>({
        workDescription: choice.workDescription,
        provision: (prose) => provisionFrame({ prose, autoTag: true }),
        call: judgeCall(),
        model: choice.judgeModel,
      });
    default: {
      // Exhaustiveness guard — a new kind without a branch fails to compile.
      const never: never = choice.kind;
      throw new Error(`unknown eval kind: ${String(never)}`);
    }
  }
}

// ── The worker step ─────────────────────────────────────────────────────────
// `step` produces the next attempt by asking the worker model to improve on the
// previous one. The previous output + its feedback are threaded into the prompt,
// so the worker refines rather than re-rolls.

/** Build the prompt for one refine step: the task, plus the previous attempt and
 * its feedback when there is one to improve on. */
export function refineStepPrompt(
  task: string,
  prev?: { output: string; score: number; feedback?: string }
): string {
  if (!prev) {
    return `${task}\n\nProduce your best attempt.`;
  }
  return [
    task,
    '',
    `Your previous attempt scored ${prev.score.toFixed(2)} out of 1.`,
    'PREVIOUS ATTEMPT:',
    prev.output,
    ...(prev.feedback ? ['', 'FEEDBACK on it:', prev.feedback] : []),
    '',
    'Produce an improved attempt that addresses the feedback. Return only the improved output.',
  ].join('\n');
}

/** The worker call a refine step drives — prompt in, text out. Defaults to
 * `delegate`; injectable for tests. */
export type StepCall = (input: { prompt: string; model?: string }) => Promise<string>;

function defaultStepCall(): StepCall {
  return ({ prompt, model }) => delegate({ prompt, model, governed: false });
}

/** Build the refine `step` for a task: each call asks the worker to produce or
 * improve an attempt. A `seedHint` (for search) is appended so diverse seeds
 * actually diverge. */
function makeRefineStep(
  task: string,
  model: string | undefined,
  call: StepCall,
  seedHint?: string
) {
  const framedTask = seedHint ? `${task}\n\nApproach: ${seedHint}` : task;
  return (prev?: { output: string; score: number; feedback?: string }) =>
    call({ prompt: refineStepPrompt(framedTask, prev), model });
}

// ── Inputs ──────────────────────────────────────────────────────────────────

const STOP_POLICY_SHAPE = {
  maxLoops: z.number().int().positive().describe('Hard cap on iterations (the backstop).'),
  targetScore: z
    .number()
    .optional()
    .describe('Stop once an attempt scores at or above this (0..1).'),
  diminishingReturns: z
    .object({
      epsilon: z.number().describe('Minimum best-score improvement to keep going.'),
      window: z.number().int().positive().describe('Iterations to measure improvement over.'),
    })
    .optional()
    .describe('Stop once the best score plateaus: improvement over `window` iters < `epsilon`.'),
};

const EVAL_SHAPE = {
  kind: z.enum(EVAL_KINDS).describe('How to score each attempt.'),
  rubric: z.string().optional().describe("For kind 'judge': the rubric to score against."),
  workDescription: z
    .string()
    .optional()
    .describe("For kind 'practices': the work to provision the bar (practices) from."),
  judgeModel: z.string().optional().describe('Worker model for the judge (model-backed evals).'),
  expression: z
    .string()
    .optional()
    .describe(
      'For kind \'deterministic\': a JS expression body scoring the string `output` to a number, e.g. `output.includes("DONE") ? 1 : 0`.'
    ),
};

export interface RefineInput {
  task: string;
  eval: EvalChoice;
  stop: StopPolicy;
  model?: string;
}

export interface SearchInput extends RefineInput {
  /** Explicit seed hints, or a count of diverse generated starts. One of the two. */
  seeds?: string[];
  seedCount?: number;
  concurrency?: number;
}

// ── The runs (pure-ish orchestration over the family) ───────────────────────

/** Run a refine loop for the tool: wire the worker step + chosen eval into the
 * pure `runRefineLoop`. `stepCall` is injectable for tests. */
export async function runRefine(
  input: RefineInput,
  stepCall: StepCall = defaultStepCall()
): Promise<RefineResult<string>> {
  const evaluate = evaluatorFor(input.eval);
  const step = makeRefineStep(input.task, input.model, stepCall);
  return runRefineLoop(step, evaluate, input.stop);
}

/** Default seed hints when the caller asks for N generated starts but gives no
 * explicit list — distinct "approaches" so the seeds diverge. */
const GENERATED_SEED_HINTS = [
  'the most direct, conventional solution',
  'optimise for clarity and simplicity above all',
  'optimise for robustness and edge-case handling',
  'take an unconventional angle others would miss',
  'optimise for performance and efficiency',
  'the most thorough, comprehensive treatment',
];

/** Resolve the seed list: explicit hints win; otherwise generate `seedCount`
 * distinct approach hints (cycling the catalogue if asked for more than it
 * holds). Always at least one seed. */
export function resolveSeeds(input: SearchInput): string[] {
  if (input.seeds && input.seeds.length > 0) return input.seeds;
  const n = Math.max(1, Math.floor(input.seedCount ?? 3));
  return Array.from({ length: n }, (_, i) => GENERATED_SEED_HINTS[i % GENERATED_SEED_HINTS.length]);
}

/** Run a multi-seed search for the tool. `stepCall` is injectable for tests. */
export async function runLoopSearch(
  input: SearchInput,
  stepCall: StepCall = defaultStepCall()
): Promise<SearchResult<string, string>> {
  const evaluate = evaluatorFor(input.eval);
  const seeds = resolveSeeds(input);
  const makeStep = (seed: string) => makeRefineStep(input.task, input.model, stepCall, seed);
  return runSearch(seeds, makeStep, evaluate, input.stop, { concurrency: input.concurrency });
}

// ── Async / background jobs ──────────────────────────────────────────────────
// Mirrors dispatch.ts: an in-process, TTL-bounded, capped job store with
// unguessable handles (IDOR-safe, STDIO-398). A refine/search run can be long
// (many worker calls), so it runs detached and is polled by handle.

export type LoopJobKind = 'refine' | 'search';

export interface LoopJob {
  id: string;
  kind: LoopJobKind;
  status: 'running' | 'done' | 'failed';
  /** A compact, legible summary once done — best score, iterations, stop reason. */
  result?: string;
  error?: string;
}

interface JobEntry {
  job: LoopJob;
  createdAt: number;
}
const JOBS = new Map<string, JobEntry>();

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_MAX_JOBS = 100;
let now: () => number = () => Date.now();
let ttlMs = DEFAULT_TTL_MS;
let maxJobs = DEFAULT_MAX_JOBS;

/** Test seam: control the job-store clock, TTL, and cap. */
export function setLoopStorePolicy(p: {
  now?: () => number;
  ttlMs?: number;
  maxJobs?: number;
}): void {
  if (p.now) now = p.now;
  if (p.ttlMs !== undefined) ttlMs = p.ttlMs;
  if (p.maxJobs !== undefined) maxJobs = p.maxJobs;
}

/** Test seam: drop all jobs and reset the store policy to defaults. */
export function clearLoopJobs(): void {
  JOBS.clear();
  now = () => Date.now();
  ttlMs = DEFAULT_TTL_MS;
  maxJobs = DEFAULT_MAX_JOBS;
}

/** Evict jobs aged past the TTL, then trim oldest-first to the cap. Lazy —
 * called on each insert and poll, so the store can't grow without bound. */
function evictStale(): void {
  const cutoff = now() - ttlMs;
  for (const [id, entry] of JOBS) {
    if (entry.createdAt < cutoff) JOBS.delete(id);
  }
  while (JOBS.size > maxJobs) {
    const oldest = JOBS.keys().next().value;
    if (oldest === undefined) break;
    JOBS.delete(oldest);
  }
}

/** Render a finished refine result as a compact, legible summary — best score,
 * the iteration it came from, stop reason, the winning output, and the trace. */
export function formatRefineResult(r: RefineResult<string>): string {
  return jsonText({
    best: { score: r.best.score, iteration: r.best.iteration, output: r.best.output },
    stoppedBy: r.stoppedBy,
    trace: r.trace,
  });
}

/** Render a finished search result: the winning seed + its result, plus every
 * seed's best (legible, not a black box). */
export function formatSearchResult(r: SearchResult<string, string>): string {
  return jsonText({
    best: {
      seed: r.best.seed,
      seedIndex: r.best.index,
      score: r.best.result.best.score,
      iteration: r.best.result.best.iteration,
      output: r.best.result.best.output,
      stoppedBy: r.best.result.stoppedBy,
    },
    seeds: r.seedRuns.map((run) => ({
      seed: run.seed,
      index: run.index,
      bestScore: run.result.best.score,
      iterations: run.result.trace.length,
      stoppedBy: run.result.stoppedBy,
    })),
  });
}

/** Start a background job over `work`, returning a handle immediately. `work`
 * does the run and returns the formatted result text. Shared by refine_start and
 * search_start so the job lifecycle (handle, eviction, status) lives in one place. */
function startJob(kind: LoopJobKind, work: () => Promise<string>): LoopJob {
  // Unguessable, non-sequential id — a caller can't enumerate or guess another
  // job's handle (IDOR; STDIO-398).
  const job: LoopJob = { id: `loop-${randomUUID()}`, kind, status: 'running' };
  JOBS.set(job.id, { job, createdAt: now() });
  evictStale();
  void work()
    .then((text) => {
      job.status = 'done';
      job.result = text;
    })
    .catch((e) => {
      job.status = 'failed';
      job.error = String(e);
    });
  return job;
}

/** Start a refine run in the background; poll with {@link loopResult}. `run` is
 * injectable for tests. */
export function startRefine(
  input: RefineInput,
  run: (i: RefineInput) => Promise<RefineResult<string>> = (i) => runRefine(i)
): LoopJob {
  return startJob('refine', async () => formatRefineResult(await run(input)));
}

/** Start a search run in the background; poll with {@link loopResult}. `run` is
 * injectable for tests. */
export function startLoopSearch(
  input: SearchInput,
  run: (i: SearchInput) => Promise<SearchResult<string, string>> = (i) => runLoopSearch(i)
): LoopJob {
  return startJob('search', async () => formatSearchResult(await run(input)));
}

/** Poll a background loop job by handle. */
export function loopResult(handle: string): LoopJob | { error: string } {
  evictStale();
  const entry = JOBS.get(handle);
  return entry ? entry.job : { error: `no loop job with handle "${handle}" (it may have expired)` };
}

/** Render a polled job as text for the tool result. */
export function formatLoopJob(job: LoopJob | { error: string }): string {
  if (!('id' in job)) return job.error; // not-found
  if (job.status === 'running') return `running (${job.kind}) — poll again with this handle`;
  if (job.status === 'failed') return `failed: ${job.error ?? 'unknown error'}`;
  return job.result ?? '(done, no output)';
}

// ── Registration ─────────────────────────────────────────────────────────────

const REFINE_DESCRIPTION =
  'Iterate-with-eval: ask the worker model for an attempt at `task`, SCORE it, feed the score back, ' +
  'and repeat until the stop policy is met — so the work improves across iterations instead of ' +
  're-rolling. Pick the eval: `deterministic` (a JS expression metric, no model), `judge` (score ' +
  'against a `rubric` via the worker), or `practices` (score against the provisioned practices for ' +
  '`workDescription` — loop until it meets the bar). Stop on any of: `maxLoops`, `targetScore`, or ' +
  'diminishing returns. Runs in the BACKGROUND (worker calls are slow) — `refine_start` returns a ' +
  'handle, poll it with `refine_result`.';

const SEARCH_DESCRIPTION =
  'Multi-seed search: run K diverse seeds, each through its own refine loop, and return the global ' +
  "best plus every seed's trace — so a search escapes a local optimum a single refine line gets " +
  'stuck in. Give explicit `seeds` (approach hints) or a `seedCount` of generated diverse starts. ' +
  'Same eval + stop choices as `refine`. Runs in the BACKGROUND — `search_start` returns a handle, ' +
  'poll it with `search_result`.';

/** Register the loop family: refine_start/refine_result and search_start/search_result. */
export function registerLoopTools(server: McpServer): void {
  server.registerTool(
    'refine_start',
    {
      description: REFINE_DESCRIPTION,
      inputSchema: {
        task: z.string().describe('The task the worker produces (and improves) an attempt at.'),
        eval: z.object(EVAL_SHAPE).describe('How to score each attempt.'),
        stop: z.object(STOP_POLICY_SHAPE).describe('When to stop iterating.'),
        model: z.string().optional().describe('Worker model for the step (the attempt-maker).'),
      },
    },
    async ({ task, eval: evalChoice, stop, model }) => {
      const job = startRefine({
        task,
        eval: evalChoice as EvalChoice,
        stop: stop as StopPolicy,
        model,
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: jsonText({
              handle: job.id,
              status: job.status,
              poll: 'call refine_result with this handle',
            }),
          },
        ],
      };
    }
  );

  server.registerTool(
    'refine_result',
    {
      description:
        'Poll a background `refine` run by its handle (from `refine_start`). Returns the status, and when done the best attempt, its score, the stop reason, and the iteration trace.',
      inputSchema: { handle: z.string().describe('The handle returned by refine_start.') },
    },
    async ({ handle }) => ({
      content: [{ type: 'text' as const, text: formatLoopJob(loopResult(handle)) }],
    })
  );

  server.registerTool(
    'search_start',
    {
      description: SEARCH_DESCRIPTION,
      inputSchema: {
        task: z.string().describe('The task each seed produces (and improves) an attempt at.'),
        eval: z.object(EVAL_SHAPE).describe('How to score each attempt.'),
        stop: z.object(STOP_POLICY_SHAPE).describe('When to stop iterating (per seed).'),
        model: z.string().optional().describe('Worker model for the step (the attempt-maker).'),
        seeds: z
          .array(z.string())
          .optional()
          .describe('Explicit approach hints, one per seed (diverse starts).'),
        seedCount: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Number of diverse generated starts when `seeds` is omitted (default 3).'),
        concurrency: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Max seeds refining at once (default: all). Bound to cap worker pressure.'),
      },
    },
    async ({ task, eval: evalChoice, stop, model, seeds, seedCount, concurrency }) => {
      const job = startLoopSearch({
        task,
        eval: evalChoice as EvalChoice,
        stop: stop as StopPolicy,
        model,
        seeds,
        seedCount,
        concurrency,
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: jsonText({
              handle: job.id,
              status: job.status,
              poll: 'call search_result with this handle',
            }),
          },
        ],
      };
    }
  );

  server.registerTool(
    'search_result',
    {
      description:
        "Poll a background `search` run by its handle (from `search_start`). Returns the status, and when done the winning seed, its best attempt and score, plus every seed's best (legible, not a black box).",
      inputSchema: { handle: z.string().describe('The handle returned by search_start.') },
    },
    async ({ handle }) => ({
      content: [{ type: 'text' as const, text: formatLoopJob(loopResult(handle)) }],
    })
  );
}
