import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { runWithVerify, formatFindings, type VerifyFinding } from '@verevoir/recipes/engine';
import { provisionFrame } from './provision.js';
import { reasoningReviewer, type Reviewer } from './review.js';
import { tierChat, type TierChat } from '../tiers.js';
import { meterFooter, resolveMeterMode, type MeterMode } from '../metering.js';
import { usageFromResponse } from '../openai-compat.js';
import { warmRegistry } from '../registry.js';
import { openSpan, deriveNote, type SpanContext } from '../audit.js';
import { sumUsages, type ModelClass, type PerModelUsage } from '@verevoir/llm';

// DELEGATE (STDIO-345 / STDIO-467) — hand a self-contained sub-task to a
// configured WORKER model and return its result. The worker is any
// OpenAI-compatible chat endpoint: a LOCAL model (Ollama / LM Studio) or a
// hosted one — OR a provider-native model (Anthropic / Gemini / etc.) when
// AIGENCY_MODEL_EXTRACTION is set without a _URI.
//
// Governed by default (STDIO-346): a worker won't fetch the bar itself, so the
// practices AND capabilities its work is held to must travel with the task. With
// the MCP loaded you've opted into governance, so delegate provisions the task and
// carries the frame into the worker's prompt — resolved anew from each worker's own
// prose, so the bar always fits the task in hand. `governed: false` opts out for
// genuinely throwaway work.
//
// The worker call is env-only. Every failure path returns a clear, actionable
// message rather than throwing — so a missing or unreachable worker reads as
// setup guidance, not a crash.
//
// DEPRECATED: AIGENCY_WORKER_MODEL / AIGENCY_WORKER_URL / AIGENCY_WORKER_API_KEY
// are aliases for AIGENCY_MODEL_EXTRACTION / AIGENCY_MODEL_EXTRACTION_URI /
// AIGENCY_MODEL_EXTRACTION_KEY. Both forms work; the AIGENCY_MODEL_EXTRACTION_*
// vars take precedence.

// Ollama's default OpenAI-compatible base URL — the common local case, so a
// local user only needs to set AIGENCY_WORKER_MODEL (or AIGENCY_MODEL_EXTRACTION).
const DEFAULT_WORKER_URL = 'http://localhost:11434/v1';

export interface WorkerConfig {
  baseUrl: string;
  model: string | null;
  apiKey: string | null;
}

/** Resolve the legacy AIGENCY_WORKER_* worker endpoint from env. URL defaults
 * to Ollama; the model is required; the key is optional (local servers don't
 * need one). Used for the direct OpenAI-compat fetch path. */
export function workerConfig(): WorkerConfig {
  // AIGENCY_MODEL_EXTRACTION_* takes precedence over AIGENCY_WORKER_* (compat aliases).
  return {
    baseUrl: (
      process.env.AIGENCY_MODEL_EXTRACTION_URI?.trim() ||
      process.env.AIGENCY_WORKER_URL?.trim() ||
      DEFAULT_WORKER_URL
    ).replace(/\/+$/, ''),
    model:
      process.env.AIGENCY_MODEL_EXTRACTION?.trim() ||
      process.env.AIGENCY_WORKER_MODEL?.trim() ||
      null,
    apiKey:
      process.env.AIGENCY_MODEL_EXTRACTION_KEY?.trim() ||
      process.env.AIGENCY_WORKER_API_KEY?.trim() ||
      null,
  };
}

// Worker configuration is project-specific (env); this message just signals the
// unconfigured state.
const NOT_CONFIGURED = "No worker model is configured for this project's MCP.";

/** A structured worker call result: the text plus what it cost. `usage` is null
 * when the worker reported none; `ok` is false for a not-configured / error
 * message (so a caller — e.g. the loop meter — can skip pricing it). On the
 * verify path `usages` carries the per-call rollups across every worker attempt
 * AND the reviewer (a different model), for the meter; `usage` stays the summed
 * worker-only rollup for the single-model consumers. */
export interface WorkerCall {
  text: string;
  ok: boolean;
  model: string | null;
  usage: PerModelUsage | null;
  usages?: PerModelUsage[];
  elapsedMs: number;
}

/**
 * Run a prompt on the configured worker model and return the STRUCTURED result —
 * text, the concrete model, token usage (when reported), and wall-clock. This is
 * the shared core: {@link delegate} wraps it to append a meter footer, and the
 * loop tools use it to accumulate per-iteration usage. Never throws — every
 * failure path returns `ok: false` with an actionable message as `text`.
 */
export async function delegateDetailed(
  input: {
    prompt: string;
    system?: string;
    model?: string;
    governed?: boolean;
    verify?: boolean;
    /** Audit span context to thread the cascade (optional; omit for standalone calls). */
    spanCtx?: SpanContext;
  },
  provision: (prose: string) => Promise<string> = (prose) =>
    provisionFrame({ prose, autoTag: true }),
  tier: (t: ModelClass) => Promise<TierChat | null> = tierChat,
  makeReviewer: (artefact?: string) => Promise<Reviewer | null> = reasoningReviewer
): Promise<WorkerCall> {
  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;

  // Open a capability-level audit span for this delegate call. The span wraps
  // the whole call (including verify retries); the per-model-call span is
  // opened inside `callWorker` and threaded as a child.
  const capSpan = openSpan('delegate', 'capability', {
    traceId: input.spanCtx?.traceId,
    parentId: input.spanCtx?.parentId,
    purpose: input.spanCtx?.purpose,
  });

  const cfg = workerConfig();
  let baseUrl = cfg.baseUrl;
  let apiKey = cfg.apiKey;
  let requested = input.model?.trim() || cfg.model;

  // Whether we resolved through a native adapter (non-URI path). When true we
  // use the adapter's ChatFn directly; when false we use raw fetch.
  let nativeTier: TierChat | null = null;

  if (!requested) {
    // No explicit or configured worker — fall back to the extraction tier,
    // resolved through the uniform adapter layer (STDIO-467). This now handles
    // Anthropic / Gemini / etc. where modelConnection() returned null before.
    const resolved = await tier('extraction');
    if (resolved) {
      requested = resolved.modelId;
      nativeTier = resolved;
    }
  }
  if (!requested) {
    capSpan.finish();
    return { text: NOT_CONFIGURED, ok: false, model: null, usage: null, elapsedMs: elapsed() };
  }
  // Address a model loosely ("deepseek") or exactly ("DeepSeek-V3.2"); resolve
  // against what the worker actually serves (cached at registration). Skip for
  // native-adapter tiers (the adapter already resolved to the concrete id).
  const model = nativeTier ? requested : resolveWorkerModel(requested, cachedWorkerModels());

  // The bar — and the capabilities — travel with the task: a worker won't fetch them
  // itself. Governed by default, so provision the worker's OWN task and prepend the
  // frame to its prompt — resolved anew from the prose handed to THIS worker, so the
  // bar fits the task in hand rather than one further up the chain. A frame fits only
  // the prose it came from, so there's nothing to pass on or reuse. `governed: false`
  // is the escape for throwaway work. provisionFrame never throws (it degrades to the
  // foundational floor), so this can't block the call.
  //
  // The worker is a weak top-of-stack with no coordinator to narrow a menu, so the
  // default provision binding uses `autoTag` — concern practices are selected in-MCP
  // and the worker gets full bodies, not a pick-list it would ignore (STDIO-348).
  const frame = input.governed !== false ? await provision(input.prompt) : null;
  const systemText = [frame, input.system?.trim()].filter(Boolean).join('\n\n') || undefined;
  const url = `${baseUrl}/chat/completions`;

  // One worker round. The user content varies per call (a verify re-produce
  // folds the review findings into it); everything else — system, model,
  // endpoint — is fixed. Never throws: every failure path is a legible
  // `ok: false` message.
  const callWorker = async (userContent: string): Promise<WorkerCall> => {
    // Open a model-call span as a child of the capability span.
    const modelSpan = openSpan(`delegate:model:${model}`, 'model', {
      traceId: capSpan.traceId,
      parentId: capSpan.spanId,
    });

    // Native-adapter path: use the tier's ChatFn (Anthropic, Gemini, etc.)
    if (nativeTier) {
      try {
        const reply = await nativeTier.chat({
          systemPrompt: systemText ?? '',
          turns: [{ role: 'user', content: userContent }],
        });
        // Map TokenUsage → PerModelUsage for the meter (same shape as usageFromResponse).
        const u = reply.usage;
        const workerUsage =
          u && (u.inputTokens > 0 || u.outputTokens > 0)
            ? usageFromResponse(u.model || model, {
                prompt_tokens: u.inputTokens + u.cacheReadInputTokens,
                completion_tokens: u.outputTokens,
                prompt_tokens_details: { cached_tokens: u.cacheReadInputTokens },
              })
            : null;
        if (workerUsage) {
          const mu = workerUsage[u.model || model];
          modelSpan.finish({
            model,
            tokens_in: mu?.in,
            tokens_out: mu?.out,
            cached: mu?.cacheRead,
          });
        } else {
          modelSpan.finish();
        }
        return { text: reply.content, ok: true, model, usage: workerUsage, elapsedMs: elapsed() };
      } catch (err) {
        modelSpan.finish();
        return {
          text: `Could not call the extraction-tier model (${model}): ${String(err).slice(0, 200)}`,
          ok: false,
          model,
          usage: null,
          elapsedMs: elapsed(),
        };
      }
    }

    // Raw OpenAI-compat fetch path (AIGENCY_WORKER_* / _URI / local Ollama).
    const messages = [
      ...(systemText ? [{ role: 'system', content: systemText }] : []),
      { role: 'user', content: userContent },
    ];
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({ model, messages }),
      });
    } catch (err) {
      modelSpan.finish();
      return {
        text:
          `Could not reach the worker at ${url} (${String(err).slice(0, 120)}). ` +
          "Is the local model server running (e.g. 'ollama serve'), or is AIGENCY_WORKER_URL correct?",
        ok: false,
        model,
        usage: null,
        elapsedMs: elapsed(),
      };
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      modelSpan.finish();
      return {
        text: `Worker returned HTTP ${res.status} from ${url} (model=${model}): ${body.slice(0, 200)}`,
        ok: false,
        model,
        usage: null,
        elapsedMs: elapsed(),
      };
    }
    const json = (await res.json().catch(() => null)) as {
      choices?: { message?: { content?: string } }[];
      usage?: import('../openai-compat.js').WorkerUsage;
    } | null;
    const content = json?.choices?.[0]?.message?.content;
    if (!content) {
      modelSpan.finish();
      return {
        text: `Worker at ${url} returned no message content (model=${model}).`,
        ok: false,
        model,
        usage: null,
        elapsedMs: elapsed(),
      };
    }
    const usage = usageFromResponse(model, json?.usage);
    // Finish the model span with verbose attributes when usage was reported.
    if (usage) {
      const u = usage[model];
      modelSpan.finish({
        model,
        tokens_in: u?.in,
        tokens_out: u?.out,
        cached: u?.cacheRead,
      });
    } else {
      modelSpan.finish();
    }
    return {
      text: content,
      ok: true,
      model,
      usage,
      elapsedMs: elapsed(),
    };
  };

  if (!input.verify) {
    const r = await callWorker(input.prompt);
    capSpan.finish();
    return r;
  }
  const reviewed = await runReviewed(input.prompt, model, callWorker, makeReviewer, elapsed);
  // Finish the capability span; on the verify path include a cost rollup when
  // usage was reported.
  const totalUsage = reviewed.usages ?? (reviewed.usage ? [reviewed.usage] : []);
  if (totalUsage.length > 0) {
    // Compute total cost lazily — warmRegistry may not have run yet for a
    // verify-path call, but best-effort is fine here (audit is observability,
    // not billing).
    try {
      const { estimateCostUSD } = await import('@verevoir/llm');
      const { sumUsages: su } = await import('@verevoir/llm');
      const rolled = su(totalUsage);
      let costRollup = 0;
      for (const [id, u] of Object.entries(rolled)) {
        const { catalogEntryFor } = await import('@verevoir/llm');
        const rates = catalogEntryFor(id)?.rates;
        if (rates) {
          costRollup += estimateCostUSD({ [id]: u }, { [id]: rates as [number, number] });
        }
      }
      capSpan.finish({ cost_rollup: costRollup });
    } catch {
      capSpan.finish();
    }
  } else {
    capSpan.finish();
  }
  return reviewed;
}

/** The directive for a verify re-produce: the original prompt plus the review's
 * blocking findings, so the worker re-reads its own output and fixes what failed. */
function withReviewFindings(prompt: string, findings: VerifyFinding[]): string {
  return (
    `${prompt}\n\n--- your previous output was rejected in an antagonistic review ---\n` +
    `Fix these blocking defects and return the corrected work IN FULL — the task is not done until the review passes:\n\n` +
    `${formatFindings(findings)}`
  );
}

/**
 * The verify path for delegate: produce → antagonistic review → re-produce on
 * the findings, to a cap (the shared `runWithVerify`). The review runs on the
 * reasoning tier, NOT the worker it judges. Preserves delegate's never-throw
 * contract: an unreachable worker, an unconfigured reviewer, and a reviewer that
 * errors mid-run each degrade to a legible note rather than an exception. The
 * worker AND reviewer usage are carried in `usages` for the meter.
 */
/** Thrown from the verify loop's producer when a RE-PRODUCE worker call fails,
 * so the loop stops rather than feeding a worker-error string to the reviewer
 * (which could "approve" it and return the error stamped as passed work). */
class ReproduceFailed extends Error {
  constructor(readonly call: WorkerCall) {
    super(call.text);
  }
}

async function runReviewed(
  prompt: string,
  model: string,
  callWorker: (userContent: string) => Promise<WorkerCall>,
  makeReviewer: (artefact?: string) => Promise<Reviewer | null>,
  elapsed: () => number
): Promise<WorkerCall> {
  const first = await callWorker(prompt);
  // An unreachable / erroring worker isn't a review failure — return it as-is.
  if (!first.ok) return first;

  // Seed the meter with the first (successful) worker call; re-produce attempts
  // and the reviewer add to it. `usage` is the summed worker-only rollup;
  // `usages` spans the worker AND the reviewer (a different model).
  const workerUsages: PerModelUsage[] = first.usage ? [first.usage] : [];
  const workerTotal = () => (workerUsages.length ? sumUsages(workerUsages) : null);
  const unreviewed = (reviewer: Reviewer | null, note: string): WorkerCall => ({
    ...first,
    usage: workerTotal(),
    usages: [...workerUsages, ...(reviewer?.usage() ?? [])],
    elapsedMs: elapsed(),
    text: `${first.text}\n\n— note: ${note}`,
  });

  // Resolving the reviewer must not break delegate's never-throw contract — a
  // construction failure degrades to a legible note, same as a missing tier.
  let reviewer: Reviewer | null;
  try {
    reviewer = await makeReviewer('work');
  } catch (err) {
    return unreviewed(
      null,
      `verify could not run (${String(err).slice(0, 120)}); returning unreviewed.`
    );
  }
  if (!reviewer) {
    return unreviewed(
      null,
      'verify was requested but no reasoning-tier model is configured (set AIGENCY_MODEL_REASONING); returning unreviewed.'
    );
  }

  let firstConsumed = false;
  let lastFindings: VerifyFinding[] = [];
  try {
    const outcome = await runWithVerify({
      capability: 'delegate',
      verify: 'adversarial-review',
      produce: async ({ findings, attempt }) => {
        lastFindings = findings;
        // Reuse the call already made for attempt 1; later attempts re-produce
        // with the review findings folded in.
        if (attempt === 1 && !firstConsumed) {
          firstConsumed = true;
          return first.text;
        }
        const call = await callWorker(withReviewFindings(prompt, findings));
        // A worker that dies mid-fix must not have its error string reviewed (and
        // possibly approved) — stop and surface the last good result instead.
        if (!call.ok) throw new ReproduceFailed(call);
        if (call.usage) workerUsages.push(call.usage);
        return call.text;
      },
      verifier: reviewer.verifier,
    });
    const verdict = outcome.converged
      ? `approved after ${outcome.attempts} attempt(s)`
      : `NOT approved after ${outcome.attempts} attempt(s):\n${formatFindings(outcome.findings)}`;
    return {
      text: `${outcome.result}\n\n— reviewed on ${reviewer.model} (reasoning): ${verdict}`,
      ok: true,
      model,
      usage: workerTotal(),
      usages: [...workerUsages, ...reviewer.usage()],
      elapsedMs: elapsed(),
    };
  } catch (err) {
    if (err instanceof ReproduceFailed) {
      // The worker couldn't be re-run to fix the review's findings. Return the
      // first (good) attempt with the outstanding findings — NEVER the worker
      // error stamped as approved.
      const outstanding = lastFindings.length ? `\n${formatFindings(lastFindings)}` : '';
      return {
        text:
          `${first.text}\n\n— note: the review requested changes but the worker could not be ` +
          `re-run to apply them (${String(err.call.text).slice(0, 120)}); returning the first ` +
          `attempt with the outstanding findings:${outstanding}`,
        ok: true,
        model,
        usage: workerTotal(),
        usages: [...workerUsages, ...reviewer.usage()],
        elapsedMs: elapsed(),
      };
    }
    // The reviewer call itself failed (transport / provider). Don't crash
    // delegate — return the worker's output unreviewed, KEEPING the reviewer's
    // already-incurred usage on the meter.
    return unreviewed(
      reviewer,
      `verify could not run (${String(err).slice(0, 120)}); returning unreviewed.`
    );
  }
}

/** Run a prompt on the configured worker model and return the assistant text
 * (with an optional meter footer), or a clear, actionable message. Never throws
 * so the coordinator can relay or repair. */
export async function delegate(
  input: {
    prompt: string;
    system?: string;
    model?: string;
    governed?: boolean;
    verify?: boolean;
    meter?: MeterMode;
    /** Audit span context to thread the cascade (optional). */
    spanCtx?: SpanContext;
  },
  provision: (prose: string) => Promise<string> = (prose) =>
    provisionFrame({ prose, autoTag: true }),
  tier: (t: ModelClass) => Promise<TierChat | null> = tierChat,
  makeReviewer: (artefact?: string) => Promise<Reviewer | null> = reasoningReviewer
): Promise<string> {
  const r = await delegateDetailed(input, provision, tier, makeReviewer);
  if (!r.ok) return r.text;
  // On the verify path `usages` spans the worker attempts AND the reviewer (a
  // different model); else it's the single worker call.
  const rounds = r.usages ?? (r.usage ? [r.usage] : []);
  return r.text + (await delegateMeterFooter(rounds, r.elapsedMs, resolveMeterMode(input.meter)));
}

/** The metering footer for a delegate call — a single worker round (STDIO-388),
 * now carrying cache tokens + wall-clock (STDIO-436). Empty for `'none'`. A
 * worker that reports no `usage` gets a legible note rather than a misleading $0
 * table: "we metered nothing" must read differently from "the worker didn't tell
 * us". Warms the provider registry so the model can be priced from the catalog
 * (idempotent — only the first metered call pays). */
async function delegateMeterFooter(
  rounds: PerModelUsage[],
  elapsedMs: number,
  mode: MeterMode
): Promise<string> {
  if (mode === 'none') return '';
  if (rounds.length === 0) {
    return '\n\n— metering: no token usage was reported —';
  }
  await warmRegistry();
  return meterFooter(rounds, mode, { timing: { totalMs: elapsedMs } });
}

/** Fetch the model ids the worker advertises via its OpenAI-compatible
 * `GET /models`, or null when unreachable / none. Lets `delegate`'s description
 * list what the worker can actually run, so a coordinator told "use deepseek"
 * can read the real id (e.g. `DeepSeek-V3.2`) and pass it per call. Bounded by a
 * short timeout so a slow/unreachable worker never hangs server start-up. */
async function fetchWorkerModels(cfg: WorkerConfig): Promise<string[] | null> {
  try {
    const res = await fetch(`${cfg.baseUrl}/models`, {
      headers: cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {},
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: { id?: string }[] };
    const ids = (json.data ?? []).map((m) => m.id).filter((x): x is string => !!x);
    return ids.length ? ids : null;
  } catch {
    return null;
  }
}

// The worker's served model ids, cached when `workerSummary` runs at tool
// registration, so `delegate` can resolve a per-call model without a second
// round-trip. Null until registration has populated it.
let cachedWorkerModelsList: string[] | null = null;

/** The worker's served model ids cached at registration, for delegate's
 * per-call model resolution. Null before registration runs. */
export function cachedWorkerModels(): string[] | null {
  return cachedWorkerModelsList;
}

/** Test seam: clear the cached worker model list. */
export function clearWorkerModelsCache(): void {
  cachedWorkerModelsList = null;
}

/** Resolve a requested model to one the worker actually serves, so a coordinator
 * can address it loosely ("deepseek") or exactly ("DeepSeek-V3.2"). Exact match
 * (case-insensitive) wins; else the served ids that contain the request, newest
 * first — so "deepseek" picks DeepSeek-V3.2 over V3.1. Returned unchanged when
 * nothing is served (can't improve on it) or nothing matches (let the worker
 * decide / error). */
export function resolveWorkerModel(requested: string, served: string[] | null): string {
  if (!served || served.length === 0) return requested;
  const lc = requested.toLowerCase();
  const exact = served.find((m) => m.toLowerCase() === lc);
  if (exact) return exact;
  const matches = served
    .filter((m) => m.toLowerCase().includes(lc))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }));
  return matches[0] ?? requested;
}

/** A host-aware one-liner for the `delegate` description: the configured worker
 * (model + endpoint) and — queried live at registration — the models it serves,
 * so a coordinator can pick one per call (`model`) when asked to "use deepseek".
 * The worker is any OpenAI-compatible endpoint, defaulting to a local Ollama at
 * 11434 when unset (STDIO-377 / STDIO-379). `fetchModels` is injectable for
 * tests. */
export async function workerSummary(
  fetchModels: (cfg: WorkerConfig) => Promise<string[] | null> = fetchWorkerModels
): Promise<string> {
  const cfg = workerConfig();
  if (!cfg.model) {
    return (
      `No worker is configured on this host: set AIGENCY_WORKER_MODEL (or AIGENCY_MODEL_EXTRACTION), ` +
      `and AIGENCY_WORKER_URL (or AIGENCY_MODEL_EXTRACTION_URI) for a non-local endpoint (default is ` +
      `local Ollama at ${DEFAULT_WORKER_URL}). The worker is any OpenAI-compatible endpoint — local ` +
      `(Ollama / LM Studio / vLLM) or hosted (e.g. DeepSeek, SambaNova) — or a provider-native ` +
      `model (e.g. AIGENCY_MODEL_EXTRACTION=haiku with ANTHROPIC_API_KEY).`
    );
  }
  const models = await fetchModels(cfg);
  cachedWorkerModelsList = models; // cache for delegate's per-call model resolution
  const available = models
    ? ` Models this worker serves (pass one as \`model\` to run a task on it — e.g. when asked to "use deepseek"): ${models.join(', ')}.`
    : '';
  return (
    `Configured worker: "${cfg.model}" at ${cfg.baseUrl} (any OpenAI-compatible endpoint; ` +
    `override the model per call with \`model\`).${available}`
  );
}

/** Register the `delegate` tool — the coordinator→worker connector. */
export async function registerDelegateTool(server: McpServer): Promise<void> {
  const summary = await workerSummary();
  server.registerTool(
    'delegate',
    {
      description:
        "Delegate a self-contained sub-task to this project's configured worker model and return its result. Use it to offload bounded work from you (the coordinator) to a cheaper worker — put everything the worker needs in `prompt`, as it sees only that, not this conversation. To run a task on a SPECIFIC model (e.g. the user says \"use deepseek to review this\"), pass `model` set to one of the worker's served models named in this description. The practices and capabilities its work is held to travel with the task automatically, provisioned afresh from this worker's own prompt (a worker won't fetch them itself, and the bar must fit the task in hand). Set `governed: false` only for throwaway work that needs no bar. Set `verify: true` to put the worker's output through an antagonistic review on the reasoning tier (looping the worker on the review's findings) before it is returned. Append token + cost metering with `meter` (or set it once via the AIGENCY_METER env). Returns the worker's text, or a short notice if no worker is configured for this project. " +
        summary,
      inputSchema: {
        prompt: z
          .string()
          .describe(
            'The full, self-contained task for the worker — it sees only this, not the conversation.'
          ),
        system: z.string().optional().describe('Optional system instruction for the worker.'),
        model: z
          .string()
          .optional()
          .describe(
            'Run this one call on a specific model instead of the configured default — pass one of the worker\'s served models named in this tool\'s description (e.g. "DeepSeek-V3.2" when asked to "use deepseek").'
          ),
        governed: z
          .boolean()
          .optional()
          .describe(
            'Default true: the worker is given the practices and capabilities its work is held to, provisioned from its own prompt. Set false only for throwaway work that needs no bar.'
          ),
        verify: z
          .boolean()
          .optional()
          .describe(
            "Default false. When true, the worker's output is put through an antagonistic review on the reasoning tier (a capable model, not the worker) before it is returned; the worker is looped on the review's blocking findings until it passes or a small attempt cap is hit. The returned text carries the review verdict. Use for work that must clear a quality bar, not throwaway."
          ),
        meter: z
          .enum(['none', 'totals-only', 'verbose'])
          .optional()
          .describe(
            'Append token + cost metering to the result: "totals-only" = a model/tokens/$ table; "verbose" = same (one worker round). Omit to use the AIGENCY_METER env default (else none).'
          ),
      },
    },
    async ({ prompt, system, model, governed, verify, meter }) => {
      const toolSpan = openSpan('tool:delegate', 'tool', {
        note: deriveNote('delegate', { prompt }),
      });
      const text = await delegate({
        prompt,
        system,
        model,
        governed,
        verify,
        meter,
        spanCtx: {
          traceId: toolSpan.traceId,
          parentId: toolSpan.spanId,
          purpose: toolSpan.purpose,
        },
      });
      toolSpan.finish();
      return { content: [{ type: 'text' as const, text }] };
    }
  );
}
