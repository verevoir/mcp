import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { provisionFrame } from './provision.js';
import { tierModel } from '../tiers.js';
import { meterFooter, resolveMeterMode, roundUsage, type MeterMode } from '../metering.js';
import { warmRegistry } from '../registry.js';
import type { ModelClass, ModelConnection } from '@verevoir/llm';

// DELEGATE (STDIO-345) — hand a self-contained sub-task to a configured WORKER
// model and return its result. The worker is any OpenAI-compatible chat
// endpoint: a LOCAL model (Ollama / LM Studio) or a hosted one. This is the
// coordinator→worker connector — it lets the model you're talking to (the
// coordinator) offload bounded work to a cheaper or local model.
//
// Governed by default (STDIO-346): a worker won't fetch the bar itself, so the
// practices AND capabilities its work is held to must travel with the task. With
// the MCP loaded you've opted into governance, so delegate provisions the task and
// carries the frame into the worker's prompt — resolved anew from each worker's own
// prose, so the bar always fits the task in hand. `governed: false` opts out for
// genuinely throwaway work.
//
// The worker call itself takes no new dependency: a plain `fetch` POST to
// `/chat/completions` (fetch is global in Node >=20). Configuration is env-only,
// and every failure path returns a clear, actionable message rather than throwing —
// so a missing or unreachable worker reads as setup guidance, not a crash.

// Ollama's default OpenAI-compatible base URL — the common local case, so a
// local user only needs to set AIGENCY_WORKER_MODEL.
const DEFAULT_WORKER_URL = 'http://localhost:11434/v1';

export interface WorkerConfig {
  baseUrl: string;
  model: string | null;
  apiKey: string | null;
}

/** Resolve the worker endpoint from env. URL defaults to Ollama; the model is
 * required; the key is optional (local servers don't need one). */
export function workerConfig(): WorkerConfig {
  return {
    baseUrl: (process.env.AIGENCY_WORKER_URL?.trim() || DEFAULT_WORKER_URL).replace(/\/+$/, ''),
    model: process.env.AIGENCY_WORKER_MODEL?.trim() || null,
    apiKey: process.env.AIGENCY_WORKER_API_KEY?.trim() || null,
  };
}

// Worker configuration is project-specific (env); this message just signals the
// unconfigured state.
const NOT_CONFIGURED = "No worker model is configured for this project's MCP.";

/** Run a prompt on the configured worker model via its OpenAI-compatible
 * chat-completions endpoint. Returns the assistant text, or a clear,
 * actionable message (never throws) so the coordinator can relay or repair. */
export async function delegate(
  input: {
    prompt: string;
    system?: string;
    model?: string;
    governed?: boolean;
    meter?: MeterMode;
  },
  provision: (prose: string) => Promise<string> = (prose) =>
    provisionFrame({ prose, autoTag: true }),
  tier: (t: ModelClass) => Promise<ModelConnection | null> = tierModel
): Promise<string> {
  const cfg = workerConfig();
  let baseUrl = cfg.baseUrl;
  let apiKey = cfg.apiKey;
  let requested = input.model?.trim() || cfg.model;
  if (!requested) {
    // No explicit or configured worker — fall back to the extraction-tier model
    // (AIGENCY_MODEL_EXTRACTION), resolved by family to a real endpoint (STDIO-380).
    const conn = await tier('extraction');
    if (conn) {
      baseUrl = conn.baseUrl;
      apiKey = conn.apiKey;
      requested = conn.modelId;
    }
  }
  if (!requested) return NOT_CONFIGURED;
  // Address a model loosely ("deepseek") or exactly ("DeepSeek-V3.2"); resolve
  // against what the worker actually serves (cached at registration).
  const model = resolveWorkerModel(requested, cachedWorkerModels());

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
  const system = [frame, input.system?.trim()].filter(Boolean).join('\n\n') || undefined;

  const messages = [
    ...(system ? [{ role: 'system', content: system }] : []),
    { role: 'user', content: input.prompt },
  ];
  const url = `${baseUrl}/chat/completions`;

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
    return (
      `Could not reach the worker at ${url} (${String(err).slice(0, 120)}). ` +
      "Is the local model server running (e.g. 'ollama serve'), or is AIGENCY_WORKER_URL correct?"
    );
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return `Worker returned HTTP ${res.status} from ${url} (model=${model}): ${body.slice(0, 200)}`;
  }
  const json = (await res.json().catch(() => null)) as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  } | null;
  const content = json?.choices?.[0]?.message?.content;
  if (!content) return `Worker at ${url} returned no message content (model=${model}).`;
  return content + (await delegateMeterFooter(model, json?.usage, resolveMeterMode(input.meter)));
}

/** The metering footer for a delegate call — a single worker round (STDIO-388).
 * Empty for `'none'`. A worker that reports no `usage` gets a legible note
 * rather than a misleading $0 table: "we metered nothing" must read differently
 * from "the worker didn't tell us". Warms the provider registry so the model can
 * be priced from the catalog (idempotent — only the first metered call pays). */
async function delegateMeterFooter(
  model: string,
  usage: { prompt_tokens?: number; completion_tokens?: number } | undefined,
  mode: MeterMode
): Promise<string> {
  if (mode === 'none') return '';
  if (!usage || (usage.prompt_tokens == null && usage.completion_tokens == null)) {
    return '\n\n— metering: the worker reported no token usage —';
  }
  await warmRegistry();
  return meterFooter(
    [roundUsage(model, usage.prompt_tokens ?? 0, usage.completion_tokens ?? 0)],
    mode
  );
}

/** A host-aware one-liner for the `delegate` description: whether a worker is
 * configured and where, so a coordinator can see the actual target rather than
 * guessing — the worker is any OpenAI-compatible endpoint, defaulting to a local
 * Ollama at 11434 when unset (STDIO-377). */
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
      `No worker is configured on this host: set AIGENCY_WORKER_MODEL, and AIGENCY_WORKER_URL for a ` +
      `non-local endpoint (default is local Ollama at ${DEFAULT_WORKER_URL}). The worker is any ` +
      `OpenAI-compatible endpoint — local (Ollama / LM Studio / vLLM) or hosted (e.g. DeepSeek, SambaNova).`
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
        "Delegate a self-contained sub-task to this project's configured worker model and return its result. Use it to offload bounded work from you (the coordinator) to a cheaper worker — put everything the worker needs in `prompt`, as it sees only that, not this conversation. To run a task on a SPECIFIC model (e.g. the user says \"use deepseek to review this\"), pass `model` set to one of the worker's served models named in this description. The practices and capabilities its work is held to travel with the task automatically, provisioned afresh from this worker's own prompt (a worker won't fetch them itself, and the bar must fit the task in hand). Set `governed: false` only for throwaway work that needs no bar. Append token + cost metering with `meter` (or set it once via the AIGENCY_METER env). Returns the worker's text, or a short notice if no worker is configured for this project. " +
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
        meter: z
          .enum(['none', 'totals-only', 'verbose'])
          .optional()
          .describe(
            'Append token + cost metering to the result: "totals-only" = a model/tokens/$ table; "verbose" = same (one worker round). Omit to use the AIGENCY_METER env default (else none).'
          ),
      },
    },
    async ({ prompt, system, model, governed, meter }) => ({
      content: [
        {
          type: 'text' as const,
          text: await delegate({ prompt, system, model, governed, meter }),
        },
      ],
    })
  );
}
