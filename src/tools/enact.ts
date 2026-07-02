import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CapabilityDescriptor } from '@verevoir/recipes';
import type { Verifier } from '@verevoir/recipes/engine';
import { openSpan, deriveNote, type SpanContext } from '../audit.js';
import { delegate } from './delegate.js';
import { reasoningReviewer, type Reviewer } from './review.js';
import { resolveVerifier } from './design-gate.js';
import { loadCapabilityCorpus } from './provision.js';

// STDIO-507 — Enact a capability, structurally.
//
// The gap this closes: a session CAN delegate bulk work to the cheaper worker
// tier with the bar attached (`delegate`), and CAN ask for it to be verified
// (`verify: true`) — but both are choices the model makes turn by turn, and the
// steer test (STDIO-508) showed a capable session left to its own judgement just
// keeps the work in-host on the reasoning tier. Guidance is not enforcement.
//
// `enact_capability` makes the enactment structural instead of advisory. The
// caller names a CAPABILITY (a corpus descriptor — what good output looks like,
// its postcondition, its gate) and a DIRECTIVE (what to produce, in this
// project). The tool then ALWAYS: provisions the bar for that work and sends it
// down with the task (governed), produces on the worker tier, and verifies the
// result against the bar on the reasoning tier, looping the worker on the
// review's findings. The tiering, the governance, and the verify are no longer
// the session's to skip — they are what this tool IS.

/** Match a requested capability name against the corpus: exact type
 * (case-insensitive) wins; else a unique substring match; else none. Returns the
 * descriptor (or null) plus the corpus's type list for a legible "did you mean". */
export function findDescriptor(
  capability: string,
  corpus: CapabilityDescriptor[]
): { descriptor: CapabilityDescriptor | null; types: string[] } {
  const types = corpus.map((c) => c.type);
  const want = capability.trim().toLowerCase();
  const exact = corpus.find((c) => c.type.toLowerCase() === want);
  if (exact) return { descriptor: exact, types };
  const partial = corpus.filter((c) => c.type.toLowerCase().includes(want));
  if (partial.length === 1) return { descriptor: partial[0], types };
  return { descriptor: null, types };
}

/** Compose the self-contained task the worker sees: the capability's intent (so
 * production aims at the right postcondition), then the caller's directive, then
 * any extra context. The worker gets only this text — it has no view of the
 * conversation — so everything it needs to produce the right thing is folded in
 * here. The provisioned bar is prepended separately by `delegate` (governed). */
export function buildEnactmentPrompt(
  descriptor: CapabilityDescriptor,
  directive: string,
  context?: string
): string {
  const parts: string[] = [];
  parts.push(`# Capability: ${descriptor.type}`);
  if (descriptor.description) parts.push(descriptor.description);
  if (descriptor.postcondition) {
    parts.push(`When this is done well, the following holds:\n${descriptor.postcondition}`);
  }
  if (descriptor.output) parts.push(`What to produce: ${descriptor.output}`);
  if (descriptor.guidance?.trim()) {
    parts.push(`How this capability is done well:\n${descriptor.guidance.trim()}`);
  }
  if (descriptor.verify) {
    // The named verifier is a HARD postcondition the work must satisfy. Where the
    // MCP can run it (see design-gate.ts) it IS enforced — the worker is looped on
    // its findings; naming it here also aims the first produce at the right
    // postcondition rather than at something merely plausible.
    parts.push(
      `This work has a hard postcondition ("${descriptor.verify}") it must satisfy — ` +
        `produce something that would pass that check, not merely something plausible.`
    );
  }
  parts.push(`# The task\n${directive.trim()}`);
  if (context?.trim()) parts.push(`# Context\n${context.trim()}`);
  return parts.join('\n\n');
}

/** A one-line header recording what was enacted and how, so the structural
 * enactment is visible in the result rather than silent. `gateName` is the
 * capability's declared verify when the MCP could run it as a hard check;
 * absent, verification fell back to the reasoning-tier practices review. */
export function enactmentHeader(
  descriptor: CapabilityDescriptor,
  verified: boolean,
  gateName?: string
): string {
  const verifyBit = !verified
    ? `verify: off (caller opted out)`
    : gateName
      ? `verified by: ${gateName} gate + reasoning review (looped)`
      : `verified on: reasoning tier (looped to the bar)`;
  const bits = [
    `capability: ${descriptor.type}`,
    `bar: provisioned + sent with the task (governed)`,
    `produced on: worker tier`,
    verifyBit,
  ];
  if (descriptor.gate && descriptor.gate !== 'none') bits.push(`gate: ${descriptor.gate}`);
  return `— enacted — ${bits.join('  ·  ')} —`;
}

export interface EnactInput {
  capability: string;
  directive: string;
  context?: string;
  model?: string;
  verify?: boolean;
  meter?: 'none' | 'totals-only' | 'verbose';
  /** Audit span context to thread the cascade (optional). */
  spanCtx?: SpanContext;
}

/** For a GATED capability, the deterministic gate owns structure + validity, so
 * the reasoning review is narrowed to material fidelity — otherwise it re-flags
 * structure / naming / completeness as blocking and never converges on a correct
 * artefact. The antagonist prompt is already material-only for code; this maps
 * "material" onto a gated artefact whose structural bar the gate already holds. */
const GATED_REVIEW_RUBRIC =
  `A deterministic gate has ALREADY verified this artefact's structure and validity — ` +
  `do not re-check or re-flag those. Review ONLY material FIDELITY: are the values correct ` +
  `and faithful to the source, and is any explicitly stated requirement genuinely unmet? ` +
  `APPROVE unless a value is materially wrong or a real stated requirement is missing. Do ` +
  `NOT block on completeness beyond what was asked, naming, formatting, structure, or design ` +
  `taste — those are the gate's domain, or are not blocking defects.`;

/**
 * Enact a capability: load its descriptor, fold its intent into a self-contained
 * task, and run it governed + verified on the worker tier. Never throws — an
 * unknown capability or an unreadable corpus returns a legible note rather than
 * crashing, so the caller can correct the name or fall back.
 *
 * `delegateFn` and `loadCorpus` are injected for tests.
 */
export async function enactCapability(
  input: EnactInput,
  delegateFn: typeof delegate = delegate,
  loadCorpus: typeof loadCapabilityCorpus = loadCapabilityCorpus,
  resolveVerifierFn: typeof resolveVerifier = resolveVerifier,
  makeReasoningReviewerFn: typeof reasoningReviewer = reasoningReviewer
): Promise<string> {
  const corpus = await loadCorpus().catch(() => [] as CapabilityDescriptor[]);
  if (corpus.length === 0) {
    return (
      `Could not load the capability corpus, so "${input.capability}" can't be enacted. ` +
      `Check the guardrails governance source is configured and reachable.`
    );
  }

  const { descriptor, types } = findDescriptor(input.capability, corpus);
  if (!descriptor) {
    const list = types.slice(0, 40).join(', ');
    return (
      `No capability matches "${input.capability}". ` +
      `Available capabilities: ${list}${types.length > 40 ? ', …' : ''}.`
    );
  }

  const verify = input.verify ?? true;
  const prompt = buildEnactmentPrompt(descriptor, input.directive, input.context);

  // A capability addressed as a tool carries its own verification. When it
  // declares a deterministic gate (`descriptor.verify`, e.g. `design-pack`) and
  // the MCP can run it, run that gate ALONGSIDE the antagonistic reasoning
  // review — not instead of it. The gate proves STRUCTURE (DTCG validity,
  // completeness); the review proves FIDELITY and judgement (the live GOV.UK run
  // showed the review catches wrong values the gate cannot see). They are staged:
  // the cheap deterministic gate filters structure first, so the expensive
  // reasoning review only runs once the output is structurally sound — and the
  // loop converges only when BOTH pass. With no runnable gate, verification is
  // the reasoning review delegate does by default. Resolution never throws.
  const gateVerifier =
    verify && descriptor.verify
      ? await resolveVerifierFn(descriptor.verify, descriptor.type).catch(() => null)
      : null;

  const span = openSpan(`enact:${descriptor.type}`, 'capability', {
    traceId: input.spanCtx?.traceId,
    parentId: input.spanCtx?.parentId,
    purpose: input.spanCtx?.purpose,
  });

  const delegateInput = {
    prompt,
    governed: true,
    verify,
    // A gated capability's deterministic gate gives precise, actionable findings
    // (the exact wrong schema, the exact unresolved refs), so the loop makes real
    // progress each round and converges with a few more of them. The review-only
    // default (3) can stop a complex artefact a finding short even as it fixes the
    // hard structural defects — observed: a full token set reached correct schema
    // + zero unresolved refs at attempt 3, still one finding from approved.
    verifyAttempts: gateVerifier ? 6 : undefined,
    model: input.model,
    meter: input.meter,
    spanCtx: { traceId: span.traceId, parentId: span.spanId, purpose: span.purpose },
  };

  // The combined reviewer for a gated capability: gate first (short-circuit its
  // findings so the worker fixes structure before any review spend), then the
  // reasoning review when the gate passes. Usage is the review's (the gate is
  // deterministic, zero tokens). Degrades to gate-only if no reasoning tier.
  const makeGatedReviewer = gateVerifier
    ? async (artefact?: string): Promise<Reviewer | null> => {
        // The deterministic gate already owns STRUCTURE + validity, so narrow the
        // review to what only judgement can catch: material FIDELITY. Without this
        // the review re-litigates structure/completeness/naming as if reviewing
        // code, manufacturing a wandering set of nit "defects" that block a
        // structurally-correct artefact forever. The antagonist prompt is already
        // material-only for CODE; this maps "material" onto a gated artefact.
        const review = await makeReasoningReviewerFn(
          artefact,
          undefined,
          GATED_REVIEW_RUBRIC
        ).catch(() => null);
        const verifier: Verifier = async (vInput) => {
          const g = await gateVerifier(vInput);
          if (!g.ok) return g;
          return review ? review.verifier(vInput) : { ok: true, findings: [] };
        };
        const label = [`${descriptor.verify} gate`, review ? `${review.model} review` : null]
          .filter(Boolean)
          .join(' + ');
        return { model: label, verifier, usage: () => review?.usage() ?? [] };
      }
    : undefined;

  const body = makeGatedReviewer
    ? await delegateFn(delegateInput, undefined, undefined, makeGatedReviewer)
    : await delegateFn(delegateInput);

  span.finish();
  return `${enactmentHeader(descriptor, verify, gateVerifier ? descriptor.verify : undefined)}\n\n${body}`;
}

/** The `enact_capability` tool description — exported so the tool-discovery
 * eval (STDIO-517) presents the real steer surface, not a paraphrase. */
export const ENACT_DESCRIPTION =
  "Enact a named capability against a directive — the governed, verified, tiered way to get a piece of bounded work produced. You name a CAPABILITY (a corpus descriptor — what a good output looks like) and a DIRECTIVE (what to produce, in this project). The tool then provisions the bar for that work and sends it down with the task, produces the result on the cheaper worker tier, and (by default) verifies it against the bar on the reasoning tier — looping the worker on the review's findings until it passes or a small cap is hit. Use this for work a capability covers (e.g. converting a design system to tokens, scaffolding a service) instead of doing the bulk yourself on the reasoning tier: the cheaper tier and the quality bar are applied structurally, not left to per-turn judgement. Returns the produced result, with a header recording what was enacted. Unknown capability names return the available list rather than failing.";

/** Register the `enact_capability` tool — the structural executor. */
export function registerEnactTool(server: McpServer): void {
  server.registerTool(
    'enact_capability',
    {
      description: ENACT_DESCRIPTION,
      inputSchema: {
        capability: z
          .string()
          .describe(
            'The capability to enact — a corpus descriptor type (e.g. "convert-design-system"). An unknown name returns the available list.'
          ),
        directive: z
          .string()
          .describe(
            "What to produce, in this project's terms — the specific task. The worker sees the capability's intent plus this; it has no view of the conversation, so be self-contained."
          ),
        context: z
          .string()
          .optional()
          .describe(
            'Optional extra context the worker needs — source URLs, constraints, prior decisions. Folded into the task verbatim.'
          ),
        model: z
          .string()
          .optional()
          .describe(
            'Run the production on a specific worker model instead of the configured default (e.g. "DeepSeek-V3.2").'
          ),
        verify: z
          .boolean()
          .optional()
          .describe(
            'Default true: verify the result against the bar on the reasoning tier, looping the worker on the findings. Set false only to produce without the verify pass (cheaper, unchecked).'
          ),
        meter: z
          .enum(['none', 'totals-only', 'verbose'])
          .optional()
          .describe(
            'Append token + cost metering to the result. Omit to use the AIGENCY_METER env default.'
          ),
      },
    },
    async ({ capability, directive, context, model, verify, meter }) => {
      const toolSpan = openSpan('tool:enact_capability', 'tool', {
        note: deriveNote('enact_capability', { capability, directive }),
      });
      const text = await enactCapability({
        capability,
        directive,
        context,
        model,
        verify,
        meter,
        spanCtx: {
          traceId: toolSpan.traceId,
          parentId: toolSpan.spanId,
          purpose: toolSpan.purpose,
        },
      });
      toolSpan.finish();
      return { content: [{ type: 'text' as const, text }] };
    }
  );
}
