// STDIO-521 — coordinator cost×quality harness: the UN-STUBBED executor.
//
// The sibling STDIO-519 executor recorded the tool call and returned a plausible
// STUB — no pipeline ran. Here the executor RUNS THE REAL TOOLS the coordinator
// calls, capturing each one's produced text AND its real per-model token usage:
//   - enact_capability → real `enactCapability` (produces on the worker tier,
//     gates + reviews). Its internal `delegate` is wrapped so the worker/reviewer
//     usage is captured.
//   - delegate / dispatch → real `delegateDetailed` with the coordinator's
//     `model` override (up→opus, down→haiku); its `usages` are captured.
//   - read_file / grep → a real read of the named source.
//   - write_file → captured into the in-memory WORKSPACE (no disk touched).
//
// Every call becomes a `RecordedCall` for the cost aggregation and appends its
// produced text to a produced-output log the quality gate later reads. Nothing
// throws — a failing real tool returns its own legible message as the tool
// result, exactly as it would to a live session, so the loop proceeds.

import type { ToolUse, PerModelUsage } from '@verevoir/llm';
import { sumUsages } from '@verevoir/llm';
import { enactCapability } from '../tools/enact.js';
import { delegateDetailed, type WorkerCall, type delegate } from '../tools/delegate.js';

/** The text-returning `delegate` signature the enact injects — shared parameter
 * list with `delegateDetailed`, so the harness can wrap one as the other. */
type Delegate = typeof delegate;
import { pickSourceAdapter, resolveSourceEnv } from '../router.js';
import { grepSource, wrapWithCache } from '@verevoir/context';
import type { RecordedCall } from './cost.js';

/** The in-memory workspace: files the coordinator "wrote", keyed by path. Never
 * touches disk — a write is captured here so the run leaves no artefacts. */
export type Workspace = Record<string, string>;

/** What the executor accumulates across a run: the ordered recorded calls (for
 * cost), the workspace (for the quality gate), and the produced-output log (the
 * enact/delegate result texts the quality gate scans for DTCG tokens). */
export interface ExecutionLog {
  calls: RecordedCall[];
  workspace: Workspace;
  /** The concatenated produced text of every enact/delegate call, newest last —
   * where the DTCG token JSON lands. */
  produced: string[];
}

export interface ExecutorDeps {
  /** Real capability enactment; injected for tests. */
  enact?: typeof enactCapability;
  /** Real worker delegation returning structured usage; injected for tests. */
  delegateFn?: typeof delegateDetailed;
  /** Reads a source file to text, or a legible message; injected for tests. */
  readSource?: (source: string, path: string) => Promise<string>;
  /** Greps a source, returning matching lines or a legible message; injected. */
  grepSourceFn?: (source: string, pattern: string) => Promise<string>;
  /** The default source used when a read/grep names none (the run's source). */
  defaultSource?: string;
}

/** Sum a WorkerCall's per-model usages into a single rollup, preferring the
 * per-call `usages` (worker attempts + reviewer) over the single `usage`. */
function rollup(call: WorkerCall): PerModelUsage {
  const rounds = call.usages ?? (call.usage ? [call.usage] : []);
  return rounds.length ? sumUsages(rounds) : {};
}

/** Record one RecordedCall per model that ran in a WorkerCall's usage rollup, so
 * a delegate that spent on both a worker and a reviewer shows both tiers. When
 * the worker reported no usage at all, record a single zero-token line under the
 * resolved model, so the call still appears in the trace. */
function recordUsage(
  log: ExecutionLog,
  tool: string,
  usage: PerModelUsage,
  fallbackModel: string,
  ms: number
): void {
  const entries = Object.entries(usage);
  if (entries.length === 0) {
    log.calls.push({ tool, model: fallbackModel, tokensIn: 0, tokensOut: 0, ms });
    return;
  }
  for (const [model, u] of entries) {
    log.calls.push({
      tool,
      model,
      tokensIn: u.in + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0),
      tokensOut: u.out,
      ms,
    });
  }
}

/** A real source read via the router adapter, or a legible message. Never throws
 * — an unreadable source reads as a note the coordinator can react to. */
async function defaultReadSource(source: string, path: string): Promise<string> {
  try {
    const adapter = wrapWithCache(await pickSourceAdapter(source));
    const env = resolveSourceEnv(source);
    const { content } = await adapter.readFile(env, source, path);
    return content;
  } catch (err) {
    return `<read_file: could not read ${path} from ${source}: ${String(err).slice(0, 160)}>`;
  }
}

/** A real grep via `@verevoir/context`, or a legible message. Never throws. */
async function defaultGrepSource(source: string, pattern: string): Promise<string> {
  try {
    const adapter = wrapWithCache(await pickSourceAdapter(source));
    const env = resolveSourceEnv(source);
    const hits = await grepSource(adapter, env, source, pattern, { maxResults: 20 });
    if (!hits.length) return `<grep: no matches for "${pattern}" in ${source}>`;
    return hits.map((h) => `${h.itemId}:${h.lineNumber}: ${h.line}`).join('\n');
  } catch (err) {
    return `<grep: could not search ${source}: ${String(err).slice(0, 160)}>`;
  }
}

/** The model override the coordinator named on a routing tool, or undefined. */
function overrideModel(input: Record<string, unknown>): string | undefined {
  return typeof input.model === 'string' && input.model.trim() ? input.model.trim() : undefined;
}

/**
 * Build the un-stubbed executor over a fresh {@link ExecutionLog}. The returned
 * function is what `chatWithToolLoop` calls per tool_use; it runs the real tool,
 * records the call + usage, appends produced text, and returns the tool's own
 * text as the tool_result. The `log` is captured by reference so the caller reads
 * the calls / workspace / produced output after the loop.
 *
 * `coordinatorModel` is passed so a delegate/enact that ran with NO explicit
 * override — falling back to the configured worker tier — is still recorded
 * under its real model, distinct from the coordinator's own driving spend.
 */
export function makeExecutor(
  log: ExecutionLog,
  deps: ExecutorDeps = {}
): (toolUse: ToolUse) => Promise<string> {
  const enact = deps.enact ?? enactCapability;
  const delegateFn = deps.delegateFn ?? delegateDetailed;
  const readSource = deps.readSource ?? defaultReadSource;
  const grepFn = deps.grepSourceFn ?? defaultGrepSource;
  const defaultSource = deps.defaultSource ?? '';

  return async (toolUse: ToolUse): Promise<string> => {
    const input = toolUse.input;
    const startedAt = Date.now();

    if (toolUse.name === 'enact_capability') {
      // Wrap the enact's internal delegate so its worker + reviewer usage is
      // captured, while the enact still sees a text-returning `delegate`.
      // `delegate` and `delegateDetailed` share their parameter list, so the
      // provision / tier / reviewer overrides the enact passes forward cleanly.
      const captured: PerModelUsage[] = [];
      const capturingDelegate: Delegate = async (di, provision, tier, makeReviewer) => {
        const call = await delegateFn(di, provision, tier, makeReviewer);
        const u = rollup(call);
        if (Object.keys(u).length) captured.push(u);
        return call.text;
      };

      const text = await enact(
        {
          capability: String(input.capability ?? ''),
          directive: String(input.directive ?? ''),
          context: typeof input.context === 'string' ? input.context : undefined,
          model: overrideModel(input),
        },
        capturingDelegate
      );
      const ms = Date.now() - startedAt;
      const usage = captured.length ? sumUsages(captured) : {};
      recordUsage(log, 'enact_capability', usage, overrideModel(input) ?? '(worker)', ms);
      log.produced.push(text);
      return text;
    }

    if (toolUse.name === 'delegate' || toolUse.name === 'dispatch') {
      const call = await delegateFn({
        prompt: String(input.prompt ?? ''),
        system: typeof input.system === 'string' ? input.system : undefined,
        model: overrideModel(input),
      });
      const ms = Date.now() - startedAt;
      recordUsage(log, toolUse.name, rollup(call), overrideModel(input) ?? '(worker)', ms);
      log.produced.push(call.text);
      return call.text;
    }

    if (toolUse.name === 'read_file') {
      const source = (typeof input.source === 'string' && input.source) || defaultSource;
      const text = source
        ? await readSource(source, String(input.path ?? ''))
        : '<read_file: no source configured for this run>';
      log.calls.push({
        tool: 'read_file',
        model: '(none)',
        tokensIn: 0,
        tokensOut: 0,
        ms: Date.now() - startedAt,
      });
      return text;
    }

    if (toolUse.name === 'grep') {
      const source = (typeof input.source === 'string' && input.source) || defaultSource;
      const text = source
        ? await grepFn(source, String(input.pattern ?? ''))
        : '<grep: no source configured for this run>';
      log.calls.push({
        tool: 'grep',
        model: '(none)',
        tokensIn: 0,
        tokensOut: 0,
        ms: Date.now() - startedAt,
      });
      return text;
    }

    if (toolUse.name === 'write_file') {
      const path = String(input.path ?? '');
      log.workspace[path] = String(input.content ?? '');
      log.calls.push({
        tool: 'write_file',
        model: '(none)',
        tokensIn: 0,
        tokensOut: 0,
        ms: Date.now() - startedAt,
      });
      return `<wrote ${path} to the run workspace (${(log.workspace[path] ?? '').length} chars)>`;
    }

    log.calls.push({
      tool: toolUse.name,
      model: '(none)',
      tokensIn: 0,
      tokensOut: 0,
      ms: Date.now() - startedAt,
    });
    return `<unknown tool ${toolUse.name} — no-op>`;
  };
}

/** A fresh, empty execution log. */
export function emptyLog(): ExecutionLog {
  return { calls: [], workspace: {}, produced: [] };
}

/** The concatenated produced output the quality gate scans for a DTCG token set
 * — the workspace files (a coordinator that wrote the token file) followed by
 * the enact/delegate produced texts, newest first, so the most recent token JSON
 * wins. */
export function producedForGate(log: ExecutionLog): string {
  return [...Object.values(log.workspace), ...[...log.produced].reverse()].join('\n\n');
}
