import { makeAdversarialReview, type ChatFn, type Verifier } from '@verevoir/recipes/engine';
import type { ChatReply, ModelClass, PerModelUsage, TokenUsage, Turn } from '@verevoir/llm';
import { tierChat, type TierChat } from '../tiers.js';
import { usageFromResponse, type WorkerUsage } from '../openai-compat.js';

// REVIEW (STDIO-458 / STDIO-467) — the antagonistic-review verify for the
// generation tools. The shared rubric verifier (`@verevoir/recipes/engine`)
// runs on the REASONING tier — a capable model, never the weak worker it is
// judging. The tier resolves through the uniform provider-adapter layer so
// Anthropic / Gemini / OpenAI-compat / local all work (STDIO-467).

/** A reasoning-tier antagonist reviewer: the verifier to hand to `runWithVerify`,
 * the concrete model it runs on (for the meter + the returned note), and the
 * token usage its calls have cost so far (so the review is metered alongside the
 * worker). */
export interface Reviewer {
  verifier: Verifier;
  model: string;
  /** The reviewer's provider (e.g. `anthropic`, `samba`) — so a caller can
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

/** Wrap a TierChat's chat function in a usage-accumulating ChatFn that maps
 * the response to the PerModelUsage shape the reviewer's meter needs.
 * The adapter's native `chat` usage tracking (TokenUsage) is separate from the
 * OpenAI-compat WorkerUsage we accumulate here — we only need the latter for
 * the existing review metering surface, so we capture it via a wrapping fetch
 * interceptor pattern. For provider-adapter tiers we call the adapter's `chat`
 * directly and extract usage from the returned TokenUsage; for direct-URI tiers
 * the fetch-level UsageFromResponse path in `openai-compat.ts` captures it. */

/** A reasoning-tier `ChatFn` bound to a resolved TierChat, accumulating
 * per-call usage. Shared by the reviewer and any other reasoning step (e.g. the
 * local-review bin's concern-tag selection) so the model wiring lives in one
 * place. */
export interface ReasoningChat {
  chat: ChatFn;
  usage(): PerModelUsage[];
}

/** Build a reasoning `ChatFn` over a resolved TierChat, accumulating per-call
 * token usage for the meter. The adapter's TokenUsage is mapped to PerModelUsage
 * (the same shape as `usageFromResponse` produces) so the downstream meter
 * doesn't care which path resolved the tier. */
export function reasoningChatFn(tierChatResult: TierChat): ReasoningChat {
  const usages: PerModelUsage[] = [];
  const { chat: adapterChat, modelId } = tierChatResult;

  const chat: ChatFn = async (opts): Promise<ChatReply> => {
    // Drive the adapter's chat. The adapter (Anthropic, Google, etc.) returns a
    // ChatReply whose `usage` is a TokenUsage — we convert it to PerModelUsage
    // for the existing review metering surface.
    const reply = await adapterChat(opts);
    const u = reply.usage;
    if (u && (u.inputTokens > 0 || u.outputTokens > 0)) {
      // Map TokenUsage → PerModelUsage (same shape usageFromResponse produces).
      const workerUsage: WorkerUsage = {
        prompt_tokens: u.inputTokens + u.cacheReadInputTokens,
        completion_tokens: u.outputTokens,
        prompt_tokens_details: { cached_tokens: u.cacheReadInputTokens },
      };
      const pu = usageFromResponse(u.model || modelId, workerUsage);
      if (pu) usages.push(pu);
    }
    return { ...reply, usage: ZERO_REPLY_USAGE, stopReason: reply.stopReason || 'end_turn' };
  };

  return { chat, usage: () => usages };
}

/** Build the reasoning-tier antagonist reviewer, or null when no reasoning tier
 * resolves (AIGENCY_MODEL_REASONING unset or un-resolvable). `tier` is
 * injectable for tests. `rubric`, when given, is the bar the work is held to;
 * omitted, the reviewer applies general engineering judgement. */
export async function reasoningReviewer(
  artefact = 'work',
  tier: (t: ModelClass) => Promise<TierChat | null> = tierChat,
  rubric?: string
): Promise<Reviewer | null> {
  const resolved = await tier('reasoning');
  if (!resolved) return null;
  const { chat, usage } = reasoningChatFn(resolved);
  return {
    verifier: makeAdversarialReview({
      chat,
      apiKey: null,
      modelClass: 'reasoning',
      artefact,
      rubric,
    }),
    model: resolved.modelId,
    provider: resolved.provider,
    usage,
  };
}
