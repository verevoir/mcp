// STDIO-517 — Tool-discovery eval: the runner.
//
// For each (model, task) it makes ONE `chatWithTools` call — the steer as the
// system prompt, the task as the user turn, the presented tools available — and
// records the model's FIRST MOVE (`toolUses[0]?.name ?? 'none'`). No tool is
// executed; we measure the routing DECISION, not the work.
//
// The model id: `chatWithTools` takes no model-id field. `ChatOptions` selects
// the concrete model from `modelClass`, which the adapter maps to a current id
// via its own catalog. So a term ("opus", "deepseek") resolves through
// `resolveModelByTerm` to a `{ provider, modelClass }`; we import THAT
// provider's adapter and pass its `modelClass` — exactly how dispatch drives a
// model. The concrete id is reporting metadata (recorded for the report), not a
// call parameter.
//
// DIAGNOSTIC: a failed cell is interrogated. We append the model's first move
// as an assistant turn and a candid follow-up as a user turn, then capture its
// plain-text account of WHY it routed the way it did. The reasoning is the
// point of the eval — it points at the fix.

import type {
  ChatOptions,
  ChatReply,
  ChatWithToolsOptions,
  ChatWithToolsResult,
  ModelClass,
  ToolDef,
} from '@verevoir/llm';
import { resolveModelByTerm } from '@verevoir/llm';
import { warmRegistry, importProviderAdapter } from '../registry.js';
import { loadInstructions } from '../instructions.js';
import { PRESENTED_TOOLS } from './tools.js';
import { TASKS, type Task } from './tasks.js';
import { score, isRunFailure, expectedToolLabel, type FirstMove, type Score } from './score.js';

/** A minimal, neutral system prompt for the `--no-steer` baseline: enough to
 * make the model act, with none of the route-at-produce-time guidance. The
 * before/after delta against the packaged instructions is what the flag
 * measures. */
export const NEUTRAL_STEER =
  'You are a capable coding assistant with tools available. Use whichever tools best accomplish the task.';

/** The steer to inject: the packaged instructions (default) or the neutral
 * baseline (`--no-steer`). */
export function steerFor(noSteer: boolean): string {
  return noSteer ? NEUTRAL_STEER : loadInstructions();
}

/** The subset of a provider adapter the runner drives. `chatWithTools` is
 * optional: an adapter without it (openai, deepseek in the installed llm) is
 * recorded as `unsupported`, never called. `chat` backs the diagnostic
 * follow-up. */
interface ToolCapableAdapter {
  chatWithTools?: (options: ChatWithToolsOptions) => Promise<ChatWithToolsResult>;
  chat?: (options: ChatOptions) => Promise<ChatReply>;
}

/** What a single (model, task) cell produced. */
export interface CellResult {
  model: string;
  taskId: string;
  firstMove: FirstMove;
  score: Score;
  /** The model's candid account of why it routed as it did — only on a failed,
   * non-run-failure cell (one extra turn). */
  reasoning?: string;
}

/** A resolved model: the provider adapter to drive, its class, and the concrete
 * id (reporting only). */
interface ResolvedModel {
  provider: string;
  modelClass: ModelClass;
  modelId: string;
  adapter: ToolCapableAdapter;
}

/** Resolve a term to a driveable, tool-capable model, or a reason it can't be
 * driven. Never throws — an unconfigured / unknown / tool-less model is a
 * legible status, not a crash. */
export async function resolveModel(term: string): Promise<ResolvedModel | { unavailable: string }> {
  const entry = resolveModelByTerm(term);
  if (!entry) {
    return {
      unavailable: `no configured provider serves "${term}" (is its API key set?)`,
    };
  }
  const load = importProviderAdapter(entry.provider);
  if (!load) return { unavailable: `provider "${entry.provider}" is unknown` };
  const adapter = (await load.catch(() => undefined)) as ToolCapableAdapter | undefined;
  if (!adapter) return { unavailable: `provider "${entry.provider}" adapter did not load` };
  if (typeof adapter.chatWithTools !== 'function') {
    return {
      unavailable: `provider "${entry.provider}" has no chatWithTools (tool use unsupported)`,
    };
  }
  return {
    provider: entry.provider,
    modelClass: entry.modelClass ?? 'reasoning',
    modelId: entry.currentId,
    adapter,
  };
}

/** The candid follow-up asked of a model that routed wrong — verbatim from the
 * eval spec, filled with the actual first move and the tool it should have
 * reached for. */
export function followUpQuestion(firstMove: FirstMove, task: Task): string {
  const expected = expectedToolLabel(task);
  return (
    `For that task you reached for ${firstMove} rather than ${expected}. ` +
    `Be candid — not a tidy post-hoc rationale: was routing to ${expected} something you ` +
    `actively weighed and decided against, or did it simply not surface as an option? ` +
    `If you saw it and chose not to use it, what was the reasoning?`
  );
}

/** Interrogate a failed cell: one more turn, the first move fed back as the
 * assistant turn, the candid follow-up as the user turn. Returns the model's
 * raw text, or a note when the follow-up itself couldn't run — the diagnostic is
 * best-effort and never breaks the run. */
async function interrogate(
  adapter: ToolCapableAdapter,
  modelClass: ModelClass,
  steer: string,
  task: Task,
  firstMove: FirstMove,
  tools: ToolDef[]
): Promise<string> {
  const assistantTurn =
    firstMove === 'none' ? 'I answered without calling a tool.' : `I called the ${firstMove} tool.`;
  const options: ChatWithToolsOptions = {
    systemPrompt: steer,
    modelClass,
    tools,
    turns: [
      { role: 'user', content: task.prompt },
      { role: 'assistant', content: assistantTurn },
      { role: 'user', content: followUpQuestion(firstMove, task) },
    ],
  };
  try {
    // Prefer chatWithTools so the tools stay visible in context; fall back to
    // plain chat if the adapter only has that. Either way we want the TEXT.
    if (adapter.chatWithTools) {
      const r = await adapter.chatWithTools(options);
      return r.text.trim() || '(model returned no reasoning text)';
    }
    if (adapter.chat) {
      const r = await adapter.chat(options);
      return r.content.trim() || '(model returned no reasoning text)';
    }
    return '(no chat surface to ask for reasoning)';
  } catch (err) {
    return `(could not capture reasoning: ${String(err).slice(0, 160)})`;
  }
}

/** Run every task for one already-resolved model. One `chatWithTools` call per
 * task; a failed cell gets one diagnostic follow-up. A per-task error is caught
 * and recorded as `error:<msg>` so one bad task never sinks the model's row. */
async function runModelTasks(
  model: string,
  resolved: ResolvedModel,
  steer: string,
  tasks: Task[],
  tools: ToolDef[]
): Promise<CellResult[]> {
  const results: CellResult[] = [];
  for (const task of tasks) {
    let firstMove: FirstMove;
    try {
      const reply = await resolved.adapter.chatWithTools!({
        systemPrompt: steer,
        modelClass: resolved.modelClass,
        tools,
        turns: [{ role: 'user', content: task.prompt }],
      });
      firstMove = reply.toolUses[0]?.name ?? 'none';
    } catch (err) {
      firstMove = `error:${String(err).slice(0, 120)}`;
    }
    const s = score(firstMove, task);
    const cell: CellResult = { model, taskId: task.id, firstMove, score: s };
    if (!s.pass && !isRunFailure(firstMove)) {
      cell.reasoning = await interrogate(
        resolved.adapter,
        resolved.modelClass,
        steer,
        task,
        firstMove,
        tools
      );
    }
    results.push(cell);
  }
  return results;
}

/** One model's whole result: its cells, or an `unavailable` reason when it
 * couldn't be driven at all (then every cell is `unsupported`). */
export interface ModelResult {
  model: string;
  modelId?: string;
  provider?: string;
  unavailable?: string;
  cells: CellResult[];
}

export interface RunOptions {
  models: string[];
  noSteer?: boolean;
  tasks?: Task[];
  tools?: ToolDef[];
}

/**
 * Run the whole matrix: every task for every model, with the diagnostic
 * follow-up on each failed cell. Warms the provider registry first so terms
 * resolve. Never throws — an unavailable model yields `unsupported` cells with
 * the reason, so the report is always complete.
 */
export async function runMatrix(opts: RunOptions): Promise<ModelResult[]> {
  const tasks = opts.tasks ?? TASKS;
  const tools = opts.tools ?? PRESENTED_TOOLS;
  const steer = steerFor(opts.noSteer ?? false);
  await warmRegistry();

  const out: ModelResult[] = [];
  for (const model of opts.models) {
    const resolved = await resolveModel(model);
    if ('unavailable' in resolved) {
      out.push({
        model,
        unavailable: resolved.unavailable,
        cells: tasks.map((task) => ({
          model,
          taskId: task.id,
          firstMove: 'unsupported',
          score: score('unsupported', task),
        })),
      });
      continue;
    }
    const cells = await runModelTasks(model, resolved, steer, tasks, tools);
    out.push({ model, modelId: resolved.modelId, provider: resolved.provider, cells });
  }
  return out;
}
