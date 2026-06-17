import { modelConnection, type ModelClass, type ModelConnection } from '@verevoir/llm';
import { warmRegistry } from './registry.js';

// Per-tier model slots (STDIO-380). aigency's model tiers map to the llm
// ModelClass ladder — reasoning / drafting / extraction — and each can be set,
// by family or id, via AIGENCY_MODEL_<TIER>. The named model resolves (through
// the registry) to a usable OpenAI-compatible connection at use time, so config
// names a model by family and the concrete version binds when it runs
// (STDIO-378). The coordinator/opus tier is the HOST's model, not set here;
// these govern aigency's own tiers — the extraction worker (delegate), and (a
// follow-on) the reasoning concern-tagger.

export const TIER_ENV: Record<ModelClass, string> = {
  reasoning: 'AIGENCY_MODEL_REASONING',
  drafting: 'AIGENCY_MODEL_DRAFTING',
  extraction: 'AIGENCY_MODEL_EXTRACTION',
};

/**
 * Resolve a tier's configured model (`AIGENCY_MODEL_<TIER>` — a family or id) to
 * a usable OpenAI-compatible connection, or `null` when the tier env is unset or
 * the model can't be resolved (no configured provider serves it, or it's
 * SDK-only). Warms the registry so the catalog is populated.
 */
export async function tierModel(tier: ModelClass): Promise<ModelConnection | null> {
  const term = process.env[TIER_ENV[tier]]?.trim();
  if (!term) return null;
  await warmRegistry();
  return modelConnection(term, { modelClass: tier });
}
