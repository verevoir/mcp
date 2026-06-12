import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// DELEGATE (STDIO-345) — hand a self-contained sub-task to a configured WORKER
// model and return its result. The worker is any OpenAI-compatible chat
// endpoint: a LOCAL model (Ollama / LM Studio) or a hosted one. This is the
// coordinator→worker connector — it lets the model you're talking to (the
// coordinator) offload bounded work to a cheaper or local model.
//
// Zero new dependency: a plain `fetch` POST to the worker's `/chat/completions`
// (fetch is global in Node >=20). Configuration is env-only, and every failure
// path returns a clear, actionable message rather than throwing — so a missing
// or unreachable worker reads as setup guidance, not a crash.

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

// Deliberately terse: the worker *configuration* is project-specific and lives
// out-of-band (private setup), not on this public surface. The operator who
// configured the project has the recipe; this message only signals the state.
const NOT_CONFIGURED = "No worker model is configured for this project's MCP.";

/** Run a prompt on the configured worker model via its OpenAI-compatible
 * chat-completions endpoint. Returns the assistant text, or a clear,
 * actionable message (never throws) so the coordinator can relay or repair. */
export async function delegate(input: {
  prompt: string;
  system?: string;
  model?: string;
}): Promise<string> {
  const cfg = workerConfig();
  const model = input.model?.trim() || cfg.model;
  if (!model) return NOT_CONFIGURED;

  const messages = [
    ...(input.system ? [{ role: 'system', content: input.system }] : []),
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
        "Delegate a self-contained sub-task to this project's configured worker model and return its result. Use it to offload bounded work from you (the coordinator) to a cheaper worker — put everything the worker needs in `prompt`, as it sees only that, not this conversation. Returns the worker's text, or a short notice if no worker is configured for this project. (Worker setup is configured out-of-band per project.)",
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
      },
    },
    async ({ prompt, system, model }) => ({
      content: [{ type: 'text' as const, text: await delegate({ prompt, system, model }) }],
    })
  );
}
