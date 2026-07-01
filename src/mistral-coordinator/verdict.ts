// STDIO-519 — Mistral-coordinator harness: the pure verdict. No I/O, no model
// calls — the whole classification is unit-testable without a network.
//
// The verdict reads an ordered routing trace (what the coordinator did across
// the loop) and answers three yes/no questions about whether it coordinated the
// "inverted tier" correctly:
//   - escalatedReasoning  — did it route the architecture DECISION up to opus?
//   - enactedCapability   — did it enact_capability the token PRODUCTION?
//   - delegatedLightDown  — did it push the README snippet DOWN to haiku?
// It "coordinates" only when all three are true.

/** One recorded coordinator move: the tool it called and the tier it named. */
export interface RoutingStep {
  /** 1-indexed order in the loop. */
  step: number;
  /** The tool the coordinator called. */
  tool: string;
  /** The `model` override it passed, or `'(default)'` when it named none. */
  model: string;
  /** A short, human-readable digest of the call's arguments — for the report. */
  argsSummary: string;
}

/** The three routing questions, plus the overall tag. */
export interface CoordinationVerdict {
  /** The architecture decision was routed UP to opus (a routing tool carrying
   * model:'opus'). */
  escalatedReasoning: boolean;
  /** The token production went through enact_capability. */
  enactedCapability: boolean;
  /** The README snippet was pushed DOWN to haiku (a routing tool carrying
   * model:'haiku'). */
  delegatedLightDown: boolean;
  /** True only when all three routes are right. */
  coordinates: boolean;
}

const ROUTING_TOOLS = new Set(['enact_capability', 'delegate', 'dispatch']);

/** Normalise a model override to a bare tier term, so `"opus"`,
 * `"claude-opus-4"`, or `"Opus"` all read as opus. `'(default)'` (no override)
 * matches nothing. */
function tier(model: string): string {
  return model.toLowerCase();
}

/** A step that handed work off (a routing tool) naming the given tier. */
function routedToTier(steps: RoutingStep[], wanted: string): boolean {
  return steps.some((s) => ROUTING_TOOLS.has(s.tool) && tier(s.model).includes(wanted));
}

/**
 * Classify a routing trace against the three inverted-tier expectations. PURE.
 *
 * - escalatedReasoning — some routing tool carried a model override naming opus.
 * - enactedCapability  — enact_capability was called at all.
 * - delegatedLightDown — some routing tool carried a model override naming haiku.
 *
 * `coordinates` is the conjunction: it only "coordinates" when it escalated the
 * reasoning, enacted the capability, AND delegated the light work down.
 */
export function classify(steps: RoutingStep[]): CoordinationVerdict {
  const escalatedReasoning = routedToTier(steps, 'opus');
  const enactedCapability = steps.some((s) => s.tool === 'enact_capability');
  const delegatedLightDown = routedToTier(steps, 'haiku');
  return {
    escalatedReasoning,
    enactedCapability,
    delegatedLightDown,
    coordinates: escalatedReasoning && enactedCapability && delegatedLightDown,
  };
}
