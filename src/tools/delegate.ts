import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { provisionFrame } from './provision.js';

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
  },
  provision: (prose: string) => Promise<string> = provisionFrame
): Promise<string> {
  const cfg = workerConfig();
  const model = input.model?.trim() || cfg.model;
  if (!model) return NOT_CONFIGURED;

  // The bar — and the capabilities — travel with the task: a worker won't fetch them
  // itself. Governed by default, so provision the worker's OWN task and prepend the
  // frame to its prompt — resolved anew from the prose handed to THIS worker, so the
  // bar fits the task in hand rather than one further up the chain. A frame fits only
  // the prose it came from, so there's nothing to pass on or reuse. `governed: false`
  // is the escape for throwaway work. provisionFrame never throws (it degrades to the
  // foundational floor), so this can't block the call.
  const frame = input.governed !== false ? await provision(input.prompt) : null;
  const system = [frame, input.system?.trim()].filter(Boolean).join('\n\n') || undefined;

  const messages = [
    ...(system ? [{ role: 'system', content: system }] : []),
    { role: 'user', content: input.prompt },
  ];
  const url = `${cfg.baseUrl}/chat/completions`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
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
  } | null;
  const content = json?.choices?.[0]?.message?.content;
  if (!content) return `Worker at ${url} returned no message content (model=${model}).`;
  return content;
}

/** Register the `delegate` tool — the coordinator→worker connector. */
export function registerDelegateTool(server: McpServer): void {
  server.registerTool(
    'delegate',
    {
      description:
        "Delegate a self-contained sub-task to this project's configured worker model and return its result. Use it to offload bounded work from you (the coordinator) to a cheaper worker — put everything the worker needs in `prompt`, as it sees only that, not this conversation. The practices and capabilities its work is held to travel with the task automatically, provisioned afresh from this worker's own prompt (a worker won't fetch them itself, and the bar must fit the task in hand). Set `governed: false` only for throwaway work that needs no bar. Returns the worker's text, or a short notice if no worker is configured for this project.",
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
          .describe('Override the configured worker model id for this one call.'),
        governed: z
          .boolean()
          .optional()
          .describe(
            'Default true: the worker is given the practices and capabilities its work is held to, provisioned from its own prompt. Set false only for throwaway work that needs no bar.'
          ),
      },
    },
    async ({ prompt, system, model, governed }) => ({
      content: [
        { type: 'text' as const, text: await delegate({ prompt, system, model, governed }) },
      ],
    })
  );
}
