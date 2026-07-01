// STDIO-521 — coordinator cost×quality harness: the coordination task.
//
// Two tasks, selected by `--scoped`:
//   - DEFAULT is the real, expensive prompt — extract the GOV.UK design system
//     into a token set and generate example sites in three stacks. It exercises
//     the full un-stubbed pipeline (an enact that really produces + gates, plus
//     whatever the coordinator routes around it).
//   - SCOPED is a cheap sibling: extract a fixed GOV.UK core palette as a DTCG
//     token set. One enact, cheap validation — the shape of the run without the
//     cost, so the harness can be exercised without a large bill.
//
// The maximal auto-answer (see run.ts) folds in the same "most expansive option"
// steer, so a coordinator that pauses to ask scope questions is pushed to the
// widest interpretation and the run continues.

/** The real, expensive default task — the prompt STDIO-521 names verbatim. */
export const DEFAULT_TASK =
  'Please look at the uk.gov design system, extract a token set and generate ' +
  'example sites in node, java and .net. You have `enact_capability`, `delegate`, ' +
  '`dispatch` (each takes a `model` override — opus is the reasoning tier, haiku ' +
  'the light tier), and `read_file`/`grep`/`write_file`. Coordinate the work: route ' +
  'each piece to where it belongs, produce the token set and the example sites, then ' +
  'report what you did.';

/** The cheap scoped task — a fixed core palette, one enact, cheap validation. */
export const SCOPED_TASK =
  'Extract this GOV.UK core palette — green #00703c, red #d4351c, blue #1d70b8, ' +
  'black #0b0c0c, mid-grey #505a5f — as a DTCG design-token set. You have ' +
  '`enact_capability`, `delegate`, `dispatch` (each takes a `model` override — opus ' +
  'is the reasoning tier, haiku the light tier), and `read_file`/`grep`/`write_file`. ' +
  'Coordinate: route the production to where it belongs and return the DTCG token JSON.';

/** The fixed maximal answer for a coordinator that pauses with a scope question:
 * take the widest option at every choice, so the run measures the most-expansive
 * path rather than stalling on a clarification. */
export const MOST_EXPANSIVE_ANSWER =
  'Take the most expansive option at every choice: full component library, ' +
  'multi-page example sites, all three stacks (node, java, .net), DTCG JSON plus ' +
  'generated CSS. Do not ask further questions — proceed with the widest interpretation.';

/** Select the task for the run. */
export function taskFor(scoped: boolean): string {
  return scoped ? SCOPED_TASK : DEFAULT_TASK;
}
