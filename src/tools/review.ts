import { makeAdversarialReview, type ChatFn, type Verifier } from '@verevoir/recipes/engine';
import type {
  ChatReply,
  ModelClass,
  ModelConnection,
  PerModelUsage,
  TokenUsage,
  Turn,
} from '@verevoir/llm';
import { tierModel } from '../tiers.js';
import { usageFromResponse, type WorkerUsage } from '../openai-compat.js';

// REVIEW (STDIO-458) — the antagonistic-review verify for the generation tools.
// The shared rubric verifier (`@verevoir/recipes/engine`) runs on the REASONING
// tier — a capable model, never the weak worker it is judging — so a delegate
// worker's output is held to a real reviewer before it is returned. The tier is
// whatever AIGENCY_MODEL_REASONING resolves to (DeepSeek / Mistral / a local
// model): provider-agnostic, in line with "use the Anthropic models efficiently
// enough that we don't have to".

/** A reasoning-tier antagonist reviewer: the verifier to hand to `runWithVerify`,
 * the concrete model it runs on (for the meter + the returned note), and the
 * token usage its calls have cost so far (so the review is metered alongside the
 * worker). */
export interface Reviewer {
  verifier: Verifier;
  model: string;
  /** The reviewer's provider (e.g. `samba`, `anthropic`) — so a caller can
   * disclose the egress of sending the reviewed text to it. Optional: a test
   * fake may omit it. */
  provider?: string;
  usage(): PerModelUsage[];
}

/** makeAdversarialReview reads only `.content`; the rest of ChatReply is filled
 * with a zero record so the type is satisfied without inventing usage we don't
 * use — the real usage is captured per-call via `usageFromResponse`. */
const ZERO_REPLY_USAGE: TokenUsage = {
  provider: '',
  model: '',
  direction: 'reasoning',
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
};

function turnText(content: Turn['content']): string {
  return typeof content === 'string'
    ? content
    : content.map((b) => (b.type === 'text' ? b.text : '')).join('');
}

/** One chat-completions call to an OpenAI-compatible reasoning connection.
 * THROWS on transport / HTTP / empty-content — the caller (delegate) catches, so
 * a review that can't run degrades to returning the work unreviewed with a
 * legible note rather than crashing the delegate call. */
async function reasoningChat(
  conn: ModelConnection,
  systemPrompt: string,
  turns: Turn[]
): Promise<{ content: string; usage: PerModelUsage | null }> {
  const messages = [
    { role: 'system', content: systemPrompt },
    ...turns.map((t) => ({ role: t.role, content: turnText(t.content) })),
  ];
  const res = await fetch(`${conn.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(conn.apiKey ? { authorization: `Bearer ${conn.apiKey}` } : {}),
    },
    body: JSON.stringify({ model: conn.modelId, messages }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`reasoning model HTTP ${res.status} (${conn.modelId}): ${body.slice(0, 160)}`);
  }
  const json = (await res.json().catch(() => null)) as {
    choices?: { message?: { content?: string } }[];
    usage?: WorkerUsage;
  } | null;
  const content = json?.choices?.[0]?.message?.content;
  if (!content) throw new Error(`reasoning model returned no content (${conn.modelId})`);
  return { content, usage: usageFromResponse(conn.modelId, json?.usage) };
}

/** Build the reasoning-tier antagonist reviewer, or null when no reasoning tier
 * is configured (AIGENCY_MODEL_REASONING unset / unresolvable) — the caller
 * surfaces that as a legible "returned unreviewed" note rather than silently
 * skipping the gate. `tier` is injectable for tests. */
export async function reasoningReviewer(
  artefact = 'work',
  tier: (t: ModelClass) => Promise<ModelConnection | null> = tierModel
): Promise<Reviewer | null> {
  const conn = await tier('reasoning');
  if (!conn) return null;
  const usages: PerModelUsage[] = [];
  const chat: ChatFn = async (opts): Promise<ChatReply> => {
    const { content, usage } = await reasoningChat(conn, opts.systemPrompt, opts.turns);
    if (usage) usages.push(usage);
    return { content, usage: ZERO_REPLY_USAGE, stopReason: 'end_turn' };
  };
  return {
    verifier: makeAdversarialReview({
      chat,
      apiKey: conn.apiKey,
      modelClass: 'reasoning',
      artefact,
    }),
    model: conn.modelId,
    provider: conn.provider,
    usage: () => usages,
  };
}
