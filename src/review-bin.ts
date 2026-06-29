#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import {
  FOUNDATIONAL,
  provisionPractices,
  isClean,
  type VerifyResult,
} from '@verevoir/recipes/engine';
import type { ModelClass } from '@verevoir/llm';
import { tierChat, type TierChat } from './tiers.js';
import { reasoningReviewer, reasoningChatFn } from './tools/review.js';
import { loadPracticeBodies, renderFrame } from './tools/provision.js';

// LOCAL ADVERSARIAL REVIEW (STDIO-473 / STDIO-467) — the off-CI review path. A
// repo that can't run the CI gate (a free private repo has no Actions minutes
// for it) wires a pre-push hook that `npx verevoir-review`s the push: the same
// reasoning-tier antagonist that backs the delegate verify (STDIO-458), held to
// the same provisioned corpus rubric, but driven over the local git diff instead
// of a worker's output.
//
// FAIL CLOSED is the whole point. A gate that silently passes when it can't run
// is worse than no gate — the push goes through believing it was reviewed. So:
//   • no reasoning tier configured (AIGENCY_MODEL_REASONING unset/unresolvable),
//   • or the rubric can't be loaded from the corpus,
// each EXIT 2 with a clear message. Exit 0 only on a real clean verdict, exit 1
// on real findings. Three distinct codes so a hook can tell "approved" from
// "rejected" from "couldn't even run".

// Whole-branch diffs are routinely large, so the cap is generous; it exists to
// stop a pathological diff blowing the reasoning model's context, not to trim
// ordinary work. Overridable for a repo that genuinely needs more.
const DEFAULT_MAX_CHANGE_BYTES = 512 * 1024;

/** The review cap in bytes: AIGENCY_REVIEW_MAX_BYTES when a positive integer,
 * else the default. A malformed override falls back rather than failing — the
 * cap is a safety bound, not a contract. */
export function maxChangeBytes(): number {
  const raw = process.env.AIGENCY_REVIEW_MAX_BYTES?.trim();
  const n = raw ? Number(raw) : NaN;
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_CHANGE_BYTES;
}

export const EXIT = { clean: 0, findings: 1, cannotRun: 2 } as const;

/** Parsed CLI args. Bare git revisions, defaulted to the common case (review
 * what `HEAD` adds over `origin/main`). */
export interface Args {
  base: string;
  head: string;
}

/** Parse `--base <rev>` / `--head <rev>` (and `--flag=value`), defaulting base
 * to `origin/main` and head to `HEAD`. Unknown flags are ignored rather than
 * fatal — a hook may pass extra context we don't consume. */
export function parseArgs(argv: string[]): Args {
  const args: Args = { base: 'origin/main', head: 'HEAD' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const [flag, inlineValue] = eq >= 0 ? [arg.slice(0, eq), arg.slice(eq + 1)] : [arg, undefined];
    const take = (): string | undefined => inlineValue ?? argv[++i];
    if (flag === '--base') args.base = take() ?? args.base;
    else if (flag === '--head') args.head = take() ?? args.head;
  }
  return args;
}

/** Run a git command in `cwd`, returning stdout (trimmed of a trailing
 * newline). THROWS on a non-zero exit so a broken ref / not-a-repo surfaces as a
 * legible failure the caller turns into exit 2, not a silent empty diff that
 * would let a push through unreviewed. */
function git(argv: string[], cwd: string): string {
  return execFileSync('git', argv, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).replace(
    /\n$/,
    ''
  );
}

/** The outcome of assembling the change text. A diff over the cap does NOT
 * degrade to a reviewed prefix — that would let a bad hunk in the cut tail slip
 * through an APPROVE. Instead `oversize` is signalled so `run` fails closed. */
export type ChangeResult =
  | { kind: 'change'; change: string }
  | { kind: 'oversize'; bytes: number; cap: number };

/** Assemble the "change under review" text from the stat summary and the
 * unified diff. When the diff exceeds `maxBytes` it returns `oversize` rather
 * than a truncated prefix — a partial review that can still APPROVE is a
 * fail-open for a gate, so the caller must fail closed instead. PURE over its
 * inputs (the git output is injected) so this is testable without a repo. */
export function assembleChange(
  stat: string,
  diff: string,
  maxBytes = maxChangeBytes()
): ChangeResult {
  const head = `# Change under review\n\n## Summary (git diff --stat)\n${stat || '(no files changed)'}\n\n## Unified diff\n`;
  const bytes = Buffer.byteLength(head, 'utf8') + Buffer.byteLength(diff, 'utf8');
  if (bytes > maxBytes) return { kind: 'oversize', bytes, cap: maxBytes };
  return { kind: 'change', change: `${head}${diff}` };
}

/** A short prose description of the change from the commit subjects on the
 * range — what the rubric is provisioned against. PURE over the raw `git log`
 * output. Falls back to a generic line when the range carries no commits (e.g.
 * uncommitted-only work) so concern-tagging still has something to classify. */
export function describeChange(logSubjects: string): string {
  const subjects = logSubjects
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  if (subjects.length === 0) return 'A code change with no commit subjects on the range.';
  return `A code change covering:\n${subjects.map((s) => `- ${s}`).join('\n')}`;
}

/** What gathering the change produced: a reviewable change + its description,
 * an empty range (nothing to review), or an oversize diff (fail closed). */
export type GatherResult =
  | { kind: 'change'; change: string; description: string }
  | { kind: 'empty' }
  | { kind: 'oversize'; bytes: number; cap: number };

/** Gather the change for a base..head range in `cwd`. The diff uses the
 * three-dot range (changes head introduced since it diverged from base) to
 * match what a reviewer of the push cares about; the log uses two-dot (commits
 * unique to head). An empty diff short-circuits before any model call; an
 * oversize diff is signalled for the caller to fail closed. */
export function gatherChange(args: Args, cwd: string): GatherResult {
  const diff = git(['diff', `${args.base}...${args.head}`], cwd);
  if (diff.trim() === '') return { kind: 'empty' };
  const stat = git(['diff', `${args.base}...${args.head}`, '--stat'], cwd);
  const assembled = assembleChange(stat, diff);
  if (assembled.kind === 'oversize') return assembled;
  const log = git(['log', `${args.base}..${args.head}`, '--format=%s'], cwd);
  return { kind: 'change', change: assembled.change, description: describeChange(log) };
}

/** Provision the corpus rubric for the change: select concern practice ids for
 * the description, union with the FOUNDATIONAL floor, load their bodies and
 * render the frame. Returns null (FAIL CLOSED) when nothing could be read — an
 * empty rubric would mean reviewing against no bar at all. Concern selection is
 * best-effort: if the reasoning call fails the floor still stands, but a frame
 * with no readable practices is a hard stop. */
export async function provisionRubric(
  description: string,
  tierResult: TierChat
): Promise<string | null> {
  const { chat } = reasoningChatFn(tierResult);
  // provisionPractices wants an apiKey; for adapter-resolved tiers we pass null
  // (the adapter already handles auth). For direct-URI tiers the key is in
  // tierResult but we don't surface it here — the adapter's ChatFn closes over
  // it already. This null is fine: the recipes engine passes it only to the
  // OpenAI-compat subpath, which our ChatFn doesn't use.
  let ids: string[];
  let taggingFailed = false;
  try {
    ids = await provisionPractices({ prose: description }, null, 'reasoning', chat);
  } catch {
    // Concern-tagging is best-effort; the floor is the irreducible bar. Note it
    // so a floor-only review is distinguishable from a fully-tagged one.
    ids = [];
    taggingFailed = true;
  }
  const union = [...new Set([...FOUNDATIONAL, ...ids])];
  const loaded = await loadPracticeBodies(union);
  if (loaded.length === 0) return null;
  const note = taggingFailed
    ? 'the bar this change is held to — concern-tagging unavailable, floor practices only'
    : 'the bar this change is held to';
  return renderFrame(loaded, union, note);
}

/** Render the verdict for the operator: an APPROVE line on a clean pass, or the
 * findings list. PURE so it's testable without a model. */
export function formatVerdict(result: VerifyResult): string {
  if (isClean(result)) return 'APPROVE — no blocking defects found.';
  const lines = result.findings.map((f) => `- ${f.where ? `${f.where}: ` : ''}${f.message}`);
  return `REJECT — blocking defects:\n${lines.join('\n') || '(reviewer rejected without itemised findings)'}`;
}

/** The CLI run, returning an exit code for the expected outcomes (empty range,
 * oversize diff, null tier, empty rubric, unavailable reviewer, clean, findings)
 * and LETTING a mid-review transport/model rejection PROPAGATE — the bin's
 * top-level `.catch` maps that to exit 2, so a review that couldn't complete is
 * never reported as an approval. Deps are injected so every wiring decision is
 * testable without a live model. */
export async function run(
  argv: string[],
  cwd: string,
  out: (s: string) => void,
  deps: {
    tier?: (t: ModelClass) => Promise<TierChat | null>;
    gather?: (args: Args, cwd: string) => GatherResult;
    provision?: (description: string, tierResult: TierChat) => Promise<string | null>;
    makeReviewer?: typeof reasoningReviewer;
  } = {}
): Promise<number> {
  const tier = deps.tier ?? tierChat;
  const gather = deps.gather ?? gatherChange;
  const provision = deps.provision ?? provisionRubric;
  const makeReviewer = deps.makeReviewer ?? reasoningReviewer;

  // Gather first: an empty range needs no review (and no tier), and an oversize
  // diff fails closed before any reasoning call is spent.
  let gathered: GatherResult;
  try {
    gathered = gather(parseArgs(argv), cwd);
  } catch (err) {
    out(
      `verevoir-review: cannot run — could not read the git diff (${err instanceof Error ? err.message : String(err)}). Failing closed.`
    );
    return EXIT.cannotRun;
  }

  if (gathered.kind === 'empty') {
    out('verevoir-review: APPROVE — no changes in range; nothing to review.');
    return EXIT.clean;
  }
  if (gathered.kind === 'oversize') {
    out(
      `verevoir-review: cannot run — diff is ${gathered.bytes} bytes, exceeds the ${gathered.cap}-byte review cap — split the change or raise AIGENCY_REVIEW_MAX_BYTES; the push was NOT reviewed.`
    );
    return EXIT.cannotRun;
  }
  const { change, description } = gathered;

  const resolved = await tier('reasoning');
  if (!resolved) {
    out(
      'verevoir-review: cannot run — no reasoning tier configured (set AIGENCY_MODEL_REASONING and its provider key). Failing closed; the push was NOT reviewed.'
    );
    return EXIT.cannotRun;
  }

  const rubric = await provision(description, resolved);
  if (!rubric) {
    out(
      'verevoir-review: cannot run — could not load the corpus rubric (check AIGENCY_GUARDRAILS_URL / corpus access). Failing closed; reviewing against no bar would be no review at all.'
    );
    return EXIT.cannotRun;
  }

  const reviewer = await makeReviewer('change', tier, rubric);
  if (!reviewer) {
    out('verevoir-review: cannot run — reasoning reviewer unavailable. Failing closed.');
    return EXIT.cannotRun;
  }

  const verdict = await reviewer.verifier({
    capability: 'local-review',
    verify: 'adversarial-review',
    result: change,
  });
  out(formatVerdict(verdict));
  return isClean(verdict) ? EXIT.clean : EXIT.findings;
}

// Only run when invoked as the bin, not when imported by a test.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  run(process.argv.slice(2), process.cwd(), (s) => console.log(s))
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      // An unexpected error (transport outage, provider 5xx mid-review) is
      // fail-closed too: a review that couldn't complete is not an approval.
      console.error(
        `verevoir-review: cannot run — ${err instanceof Error ? err.message : String(err)}. Failing closed.`
      );
      process.exit(EXIT.cannotRun);
    });
}
