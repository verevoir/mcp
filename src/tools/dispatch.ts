import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  resolveModelByTerm,
  type ModelClass,
  type ToolDef,
  type ToolUse,
  type ToolExecutor,
  type ChatWithToolLoopResult,
  type TokenUsage,
} from '@verevoir/llm';
import { meterFooter, roundUsage, type MeterMode } from '../metering.js';
import { importProviderAdapter, warmRegistry } from '../registry.js';
import { grepSource, warmSource, wrapWithCache } from '@verevoir/context';
import { findSymbols } from '@verevoir/context/code';
import { pickSourceAdapter, resolveSourceEnv } from '../router.js';
import { jsonText } from '../result.js';
import { provisionFrame } from './provision.js';
import { commitArgs } from './source.js';
import { applyEdit } from '../edit.js';
import { invalidateWrittenFile } from '../cache.js';

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
  onIteration?: (info: {
    iteration: number;
    toolUses: ToolUse[];
    stopReason: string;
  }) => Promise<void>;
  onUsage?: (usage: TokenUsage) => Promise<void>;
};
type ToolLoopAdapter = {
  chatWithToolLoop: (opts: ToolLoopOptions) => Promise<ChatWithToolLoopResult>;
};
const SOURCE_PROP = {
  sourceUrl: {
    type: 'string',
    description:
      'The source to read from (a local path, GitHub repo, or Notion url). Omit to use the dispatch source.',
  },
} as const;

/** The toolbelt the frontier worker drives — read, governance, and write. It can
 * change the source (write_file / edit_file); it cannot delegate/dispatch further
 * or touch the card/board tools. */
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
  {
    name: 'write_file',
    description:
      "Write a file's full contents to the source. For a GitHub source, set branch + commitMessage; for a local path omit them.",
    input_schema: {
      type: 'object',
      properties: {
        ...SOURCE_PROP,
        path: { type: 'string', description: 'File path.' },
        content: { type: 'string', description: 'Full file content.' },
        branch: { type: 'string', description: 'GitHub branch to commit to (omit for local).' },
        commitMessage: { type: 'string', description: 'GitHub commit message (omit for local).' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description:
      'Replace an exact oldString with newString in a file. oldString must match once unless replaceAll. For GitHub, set branch + commitMessage.',
    input_schema: {
      type: 'object',
      properties: {
        ...SOURCE_PROP,
        path: { type: 'string', description: 'File path.' },
        oldString: { type: 'string', description: 'Exact text to replace.' },
        newString: { type: 'string', description: 'Replacement text.' },
        replaceAll: { type: 'boolean', description: 'Replace every occurrence (default false).' },
        branch: { type: 'string', description: 'GitHub branch (omit for local).' },
        commitMessage: { type: 'string', description: 'GitHub commit message (omit for local).' },
      },
      required: ['path', 'oldString', 'newString'],
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
      case 'write_file': {
        const adapter = await pickSourceAdapter(sourceUrl);
        const env = resolveSourceEnv(sourceUrl);
        const commit = commitArgs(
          sourceUrl,
          input.branch as string | undefined,
          input.commitMessage as string | undefined
        );
        await adapter.writeFile(
          env,
          sourceUrl,
          String(input.path),
          String(input.content),
          commit.branch,
          commit.commitMessage
        );
        invalidateWrittenFile(sourceUrl, String(input.path), commit.branch);
        return jsonText({ ok: true });
      }
      case 'edit_file': {
        const adapter = await pickSourceAdapter(sourceUrl);
        const env = resolveSourceEnv(sourceUrl);
        const commit = commitArgs(
          sourceUrl,
          input.branch as string | undefined,
          input.commitMessage as string | undefined
        );
        const { content } = await adapter.readFile(
          env,
          sourceUrl,
          String(input.path),
          commit.branch || undefined
        );
        const result = applyEdit(
          content,
          String(input.oldString),
          String(input.newString),
          Boolean(input.replaceAll)
        );
        await adapter.writeFile(
          env,
          sourceUrl,
          String(input.path),
          result.content,
          commit.branch,
          commit.commitMessage
        );
        invalidateWrittenFile(sourceUrl, String(input.path), commit.branch);
        return jsonText({ ok: true, replacements: result.replacements });
      }
      default:
        throw new Error(`unknown tool: ${use.name}`);
    }
  };
}

function systemPrompt(source: string): string {
  return (
    `You are an autonomous agent working on the source at: ${source}\n\n` +
    `You have tools you drive yourself — provision, read_file, grep, find_symbol, and (when the task ` +
    `calls for changes) write_file and edit_file. Work the task: explore the source with ` +
    `grep/find_symbol/read_file, and call \`provision\` with a short description of the work to get ` +
    `the practices your output is held to BEFORE you judge, recommend, or change anything — then hold ` +
    `your output to them. Make changes with write_file/edit_file only when the task asks for them. ` +
    `When a tool needs a source and you mean the one above, you may omit sourceUrl. Produce the ` +
    `finished work as your final message; do not ask for confirmation.`
  );
}

/** What dispatch needs from the outside, injectable for tests. */
export interface DispatchDeps {
  resolve?: (term: string) => { provider: string; modelClass?: ModelClass } | null;
  loadAdapter?: (provider: string) => Promise<ToolLoopAdapter>;
  warm?: () => Promise<void>;
  executorFor?: (source: string) => ToolExecutor;
  /** Called once per tool-loop round with a compact progress line — so a slow
   * run is observable. Defaults to a stderr log; the tool handler also pushes
   * an MCP progress notification to the host. */
  onProgress?: (message: string) => void;
}

/** Run a frontier model as an agent over the source. Returns its final text
 * plus a one-line trace of the tools it drove, or a clear message when the
 * model can't be resolved / driven. */
export async function dispatchTask(
  input: {
    prompt: string;
    model: string;
    source: string;
    maxIterations?: number;
    meter?: MeterMode;
  },
  deps: DispatchDeps = {}
): Promise<string> {
  const warm = deps.warm ?? warmRegistry;
  const resolve = deps.resolve ?? ((t: string) => resolveModelByTerm(t));
  const load =
    deps.loadAdapter ?? ((p: string) => importProviderAdapter(p) as Promise<ToolLoopAdapter>);
  const makeExec = deps.executorFor ?? makeDispatchExecutor;
  const progress = deps.onProgress ?? ((m: string) => console.error(`[dispatch] ${m}`));

  await warm();
  const entry = resolve(input.model);
  if (!entry) {
    return `No configured provider serves a model matching "${input.model}". Set the provider's API key, or pick a served model.`;
  }
  const adapter = await load(entry.provider);
  if (!adapter?.chatWithToolLoop) {
    return `Provider "${entry.provider}" can't be driven as an agent (no tool loop).`;
  }

  const usages: ReturnType<typeof roundUsage>[] = [];
  const stages: string[] = [];
  const result = await adapter.chatWithToolLoop({
    systemPrompt: systemPrompt(input.source),
    turns: [{ role: 'user', content: input.prompt }],
    modelClass: entry.modelClass ?? 'reasoning',
    tools: DISPATCH_TOOLS,
    executor: makeExec(input.source),
    maxIterations: input.maxIterations ?? 12,
    onUsage: async (u) => {
      usages.push(roundUsage(u.model, u.inputTokens, u.outputTokens));
    },
    onIteration: async (info) => {
      const names = info.toolUses.map((u) => u.name).join(', ') || '(thinking)';
      stages.push(names);
      progress(`round ${info.iteration}: ${names}`);
    },
  });

  const drove = result.toolUses.map((u) => u.name);
  const trace = drove.length ? `\n\n— drove ${drove.length} tool call(s): ${drove.join(', ')}` : '';
  const footer = meterFooter(usages, input.meter ?? 'none', stages);
  return `${result.text}${trace}${footer}`;
}

// ── Async / background dispatch (STDIO-384) ─────────────────────────────────
// A synchronous tool call is bounded by the host's request timeout, so a long
// agentic run on a slow hosted model times out. `dispatch_start` kicks the loop
// off detached and returns a handle immediately; `dispatch_result` polls. The
// run pushes its progress into the job as it goes.

export type DispatchInput = {
  prompt: string;
  model: string;
  source: string;
  maxIterations?: number;
  meter?: MeterMode;
};

export interface DispatchJob {
  id: string;
  status: 'running' | 'done' | 'failed';
  progress: string[];
  result?: string;
  error?: string;
}

const JOBS = new Map<string, DispatchJob>();
let jobSeq = 0;

/** Test seam: drop all background jobs. */
export function clearDispatchJobs(): void {
  JOBS.clear();
  jobSeq = 0;
}

/** Start a dispatch run in the background; returns a handle immediately. The
 * loop runs detached, pushing progress into the job; poll it with
 * {@link dispatchResult}. `run` is injectable for tests. */
export function startDispatch(
  input: DispatchInput,
  run: (i: DispatchInput, deps: DispatchDeps) => Promise<string> = dispatchTask
): DispatchJob {
  jobSeq += 1;
  const job: DispatchJob = { id: `disp-${jobSeq}`, status: 'running', progress: [] };
  JOBS.set(job.id, job);
  void run(input, { onProgress: (m) => job.progress.push(m) })
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

/** Poll a background dispatch job by handle. */
export function dispatchResult(handle: string): DispatchJob | { error: string } {
  return JOBS.get(handle) ?? { error: `no dispatch job with handle "${handle}"` };
}

/** Render a polled job as text for the tool result. */
export function formatJob(job: DispatchJob | { error: string }): string {
  if (!('id' in job)) return job.error; // the not-found { error } case
  if (job.status === 'running') {
    const tail = job.progress.length ? `:\n${job.progress.join('\n')}` : ' (no progress yet)';
    return `running — ${job.progress.length} round(s) so far${tail}`;
  }
  if (job.status === 'failed') return `failed: ${job.error ?? 'unknown error'}`;
  return job.result ?? '(done, no output)';
}

/** Register the `dispatch` tool — run a frontier non-Claude model as an MCP
 * agent over a source, with a read-only toolbelt it drives itself. */
export function registerDispatchTool(server: McpServer): void {
  server.registerTool(
    'dispatch',
    {
      description:
        'Hand a whole task to a FRONTIER worker model (e.g. DeepSeek) and let it drive: it gets a toolbelt (read_file, grep, find_symbol, provision, and write_file/edit_file when the task calls for changes) and works autonomously over a source — exploring, pulling its own practices, reading real code, and producing or changing it. Runs can be slow (each round is a full worker call) and it emits progress as it goes — for a large task on a slow/hosted model that would exceed a synchronous tool-call timeout, use `dispatch_start` (background) + `dispatch_result` (poll) instead. Use this (not `delegate`) when you want the worker to do the agentic work itself rather than judge a pre-chewed prompt. `model` is a family or id (e.g. "deepseek"); `source` is the repo/path it works over.',
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
        meter: z
          .enum(['none', 'totals-only', 'verbose'])
          .optional()
          .describe(
            'Append token + cost metering: "totals-only" = a model/class/tokens/$ table at the end; "verbose" = that plus a line per tool round. Default none.'
          ),
      },
    },
    async ({ prompt, model, source, maxIterations, meter }, extra) => {
      // Surface live progress: stderr (server logs) + an MCP progress
      // notification to the host (best-effort — only when it passed a token).
      const meta = (extra as { _meta?: { progressToken?: string | number } } | undefined)?._meta;
      const progressToken = meta?.progressToken;
      const send = (extra as { sendNotification?: (n: unknown) => Promise<unknown> } | undefined)
        ?.sendNotification;
      let n = 0;
      const onProgress = (message: string) => {
        n += 1;
        console.error(`[dispatch] ${message}`);
        if (progressToken !== undefined && send) {
          void Promise.resolve(
            send({
              method: 'notifications/progress',
              params: { progressToken, progress: n, total: maxIterations ?? 12, message },
            })
          ).catch(() => {});
        }
      };
      return {
        content: [
          {
            type: 'text' as const,
            text: await dispatchTask(
              { prompt, model, source, maxIterations, meter },
              { onProgress }
            ),
          },
        ],
      };
    }
  );

  server.registerTool(
    'dispatch_start',
    {
      description:
        'Start a `dispatch` run in the BACKGROUND and return a handle immediately — use this (not `dispatch`) for a large task on a slow/hosted model that would exceed a synchronous tool-call timeout. Poll the handle with `dispatch_result`. Same args as `dispatch`.',
      inputSchema: {
        prompt: z.string().describe('The task for the worker — what to produce.'),
        model: z.string().describe('The worker model, by family or id (e.g. "deepseek").'),
        source: z.string().describe('The source the worker reads from.'),
        maxIterations: z.number().optional().describe('Cap on tool-call rounds (default 12).'),
        meter: z
          .enum(['none', 'totals-only', 'verbose'])
          .optional()
          .describe('Token + cost metering on the result (see `dispatch`). Default none.'),
      },
    },
    async ({ prompt, model, source, maxIterations, meter }) => {
      const job = startDispatch({ prompt, model, source, maxIterations, meter });
      return {
        content: [
          {
            type: 'text' as const,
            text: jsonText({
              handle: job.id,
              status: job.status,
              poll: 'call dispatch_result with this handle',
            }),
          },
        ],
      };
    }
  );

  server.registerTool(
    'dispatch_result',
    {
      description:
        'Poll a background `dispatch` run by its handle (from `dispatch_start`). Returns the status (running / done / failed), the progress so far, and the result text when done.',
      inputSchema: {
        handle: z.string().describe('The handle returned by dispatch_start.'),
      },
    },
    async ({ handle }) => ({
      content: [{ type: 'text' as const, text: formatJob(dispatchResult(handle)) }],
    })
  );
}
