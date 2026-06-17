import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  resolveModelByTerm,
  type ModelClass,
  type ToolDef,
  type ToolUse,
  type ToolExecutor,
  type ChatWithToolLoopResult,
} from '@verevoir/llm';
import { grepSource, warmSource, wrapWithCache } from '@verevoir/context';
import { findSymbols } from '@verevoir/context/code';
import { pickSourceAdapter, resolveSourceEnv } from '../router.js';
import { jsonText } from '../result.js';
import { provisionFrame } from './provision.js';

// DISPATCH (STDIO-381) — run a FRONTIER non-Claude model as an MCP agent.
//
// The complement to `delegate`. `delegate` is the LOWER-model pattern: one-shot,
// text-in/text-out, no tools, the bar pre-attached (`governed`). A frontier
// model (e.g. DeepSeek on SambaNova) can do more — given the toolbelt and a long
// leash it will explore the source, pull its own practices, read real code, and
// produce the work. `dispatch` gives it exactly that: a curated, READ-ONLY
// toolset (read_file / grep / find_symbol / provision) bound to a tool loop, so
// it drives instead of grading a pre-chewed digest.
//
// Two pieces make this reachable: `@verevoir/llm`'s `chatWithToolLoop` (an
// automated agentic loop for OpenAI-compatible providers) and `resolveModelByTerm`
// (term → provider + class + current id). The worker self-serves its bar by
// calling `provision`, mirroring the coordinator-narrows model.

// Provider → its tool-loop adapter. The SDKs are bundled (STDIO-377). Importing
// also registers the provider's catalog + connection, so `resolveModelByTerm`
// can see it.
type ToolLoopOptions = {
  systemPrompt: string;
  turns: { role: 'user' | 'assistant'; content: string }[];
  modelClass?: ModelClass;
  tools: ToolDef[];
  executor: ToolExecutor;
  maxIterations?: number;
};
type ToolLoopAdapter = {
  chatWithToolLoop: (opts: ToolLoopOptions) => Promise<ChatWithToolLoopResult>;
};
const ADAPTERS: Record<string, () => Promise<ToolLoopAdapter>> = {
  openai: () => import('@verevoir/llm/openai') as unknown as Promise<ToolLoopAdapter>,
  deepseek: () => import('@verevoir/llm/deepseek') as unknown as Promise<ToolLoopAdapter>,
  samba: () => import('@verevoir/llm/samba') as unknown as Promise<ToolLoopAdapter>,
  mistral: () => import('@verevoir/llm/mistral') as unknown as Promise<ToolLoopAdapter>,
  anthropic: () => import('@verevoir/llm/anthropic') as unknown as Promise<ToolLoopAdapter>,
  google: () => import('@verevoir/llm/google') as unknown as Promise<ToolLoopAdapter>,
};

let warmed = false;
/** Import the provider adapters once so the llm catalog (which `resolveModelByTerm`
 * reads) is populated. Best-effort — an unimportable adapter is skipped. */
async function warmRegistry(): Promise<void> {
  if (warmed) return;
  await Promise.all(
    Object.values(ADAPTERS).map(async (load) => {
      try {
        await load();
      } catch {
        // skip an adapter whose SDK can't load
      }
    })
  );
  warmed = true;
}

/** Test seam: reset the warm-once latch. */
export function resetDispatchWarm(): void {
  warmed = false;
}

const SOURCE_PROP = {
  sourceUrl: {
    type: 'string',
    description:
      'The source to read from (a local path, GitHub repo, or Notion url). Omit to use the dispatch source.',
  },
} as const;

/** The READ-ONLY toolbelt the frontier worker drives. No write_file / edit_file /
 * delegate / dispatch — a worker reads and reasons, it does not mutate. */
export const DISPATCH_TOOLS: ToolDef[] = [
  {
    name: 'provision',
    description:
      'Before you judge or change code, call this with a short description of the work to get the practices your output is held to — the bar. Returns the foundational floor in full plus a menu of concern practices.',
    input_schema: {
      type: 'object',
      properties: { prose: { type: 'string', description: 'Short description of the work.' } },
      required: ['prose'],
    },
  },
  {
    name: 'read_file',
    description: "Read a file's full contents from the source.",
    input_schema: {
      type: 'object',
      properties: { ...SOURCE_PROP, path: { type: 'string', description: 'File path.' } },
      required: ['path'],
    },
  },
  {
    name: 'grep',
    description: 'Search file contents across the source for a plain-text pattern.',
    input_schema: {
      type: 'object',
      properties: { ...SOURCE_PROP, pattern: { type: 'string', description: 'Text to find.' } },
      required: ['pattern'],
    },
  },
  {
    name: 'find_symbol',
    description: 'Find where a function/class/type is defined in the source.',
    input_schema: {
      type: 'object',
      properties: { ...SOURCE_PROP, name: { type: 'string', description: 'Symbol name.' } },
      required: ['name'],
    },
  },
];

/** Build the executor that runs the worker's tool calls in-process against the
 * MCP's own read functions, defaulting an omitted `sourceUrl` to the dispatch
 * source. */
export function makeDispatchExecutor(defaultSource: string): ToolExecutor {
  return async (use: ToolUse): Promise<string> => {
    const input = use.input as Record<string, unknown>;
    const sourceUrl = (input.sourceUrl as string | undefined)?.trim() || defaultSource;
    switch (use.name) {
      case 'provision':
        return provisionFrame({ prose: String(input.prose ?? '') });
      case 'read_file': {
        const adapter = wrapWithCache(await pickSourceAdapter(sourceUrl));
        const env = resolveSourceEnv(sourceUrl);
        return jsonText(await adapter.readFile(env, sourceUrl, String(input.path), undefined));
      }
      case 'grep': {
        const adapter = await pickSourceAdapter(sourceUrl);
        const env = resolveSourceEnv(sourceUrl);
        return jsonText(await grepSource(adapter, env, sourceUrl, String(input.pattern), {}));
      }
      case 'find_symbol': {
        const adapter = await pickSourceAdapter(sourceUrl);
        const env = resolveSourceEnv(sourceUrl);
        await warmSource(adapter, env, sourceUrl, {});
        return jsonText(
          findSymbols(String(input.name), { sources: [{ sourceId: sourceUrl, version: '' }] })
        );
      }
      default:
        throw new Error(`unknown tool: ${use.name}`);
    }
  };
}

function systemPrompt(source: string): string {
  return (
    `You are an autonomous agent working on the source at: ${source}\n\n` +
    `You have READ-ONLY tools — provision, read_file, grep, find_symbol — that you drive yourself. ` +
    `Work the task: explore the source with grep/find_symbol/read_file, and call \`provision\` with a ` +
    `short description of the work to get the practices your output is held to BEFORE you judge or ` +
    `recommend anything — then hold your output to them. When a tool needs a source and you mean the ` +
    `one above, you may omit sourceUrl. Produce the finished work as your final message; do not ask ` +
    `for confirmation.`
  );
}

/** What dispatch needs from the outside, injectable for tests. */
export interface DispatchDeps {
  resolve?: (term: string) => { provider: string; modelClass?: ModelClass } | null;
  loadAdapter?: (provider: string) => Promise<ToolLoopAdapter>;
  warm?: () => Promise<void>;
  executorFor?: (source: string) => ToolExecutor;
}

/** Run a frontier model as an agent over the source. Returns its final text
 * plus a one-line trace of the tools it drove, or a clear message when the
 * model can't be resolved / driven. */
export async function dispatchTask(
  input: { prompt: string; model: string; source: string; maxIterations?: number },
  deps: DispatchDeps = {}
): Promise<string> {
  const warm = deps.warm ?? warmRegistry;
  const resolve = deps.resolve ?? ((t: string) => resolveModelByTerm(t));
  const load = deps.loadAdapter ?? ((p: string) => ADAPTERS[p]?.());
  const makeExec = deps.executorFor ?? makeDispatchExecutor;

  await warm();
  const entry = resolve(input.model);
  if (!entry) {
    return `No configured provider serves a model matching "${input.model}". Set the provider's API key, or pick a served model.`;
  }
  const adapter = await load(entry.provider);
  if (!adapter?.chatWithToolLoop) {
    return `Provider "${entry.provider}" can't be driven as an agent (no tool loop).`;
  }

  const result = await adapter.chatWithToolLoop({
    systemPrompt: systemPrompt(input.source),
    turns: [{ role: 'user', content: input.prompt }],
    modelClass: entry.modelClass ?? 'reasoning',
    tools: DISPATCH_TOOLS,
    executor: makeExec(input.source),
    maxIterations: input.maxIterations ?? 12,
  });

  const drove = result.toolUses.map((u) => u.name);
  const trace = drove.length ? `\n\n— drove ${drove.length} tool call(s): ${drove.join(', ')}` : '';
  return `${result.text}${trace}`;
}

/** Register the `dispatch` tool — run a frontier non-Claude model as an MCP
 * agent over a source, with a read-only toolbelt it drives itself. */
export function registerDispatchTool(server: McpServer): void {
  server.registerTool(
    'dispatch',
    {
      description:
        'Hand a whole task to a FRONTIER worker model (e.g. DeepSeek) and let it drive: it gets a read-only toolbelt (read_file, grep, find_symbol, provision) and works autonomously over a source — exploring, pulling its own practices, reading real code, producing the result. Use this (not `delegate`) when you want the worker to do the agentic work itself rather than judge a pre-chewed prompt. `model` is a family or id (e.g. "deepseek"); `source` is the repo/path it works over.',
      inputSchema: {
        prompt: z.string().describe('The task for the worker — what to produce.'),
        model: z
          .string()
          .describe(
            'The worker model, by family or id (e.g. "deepseek"). Resolved via the registry.'
          ),
        source: z
          .string()
          .describe('The source the worker reads from (local path, GitHub repo, or Notion url).'),
        maxIterations: z.number().optional().describe('Cap on tool-call rounds (default 12).'),
      },
    },
    async ({ prompt, model, source, maxIterations }) => ({
      content: [
        {
          type: 'text' as const,
          text: await dispatchTask({ prompt, model, source, maxIterations }),
        },
      ],
    })
  );
}
