// STDIO-519 — Mistral-coordinator harness: the coordination task.
//
// ONE multi-part task that exercises all three routes at once. The GOV.UK
// palette is provided INLINE so the coordinator needs no web or filesystem read
// to do the work — the harness is about routing JUDGEMENT, not fetching. The
// three pieces are deliberately of different shapes so the right home for each
// differs:
//   (a) decide the token architecture — a hard design-reasoning judgement → UP to opus
//   (b) extract the full token set as DTCG JSON — capability-shaped production → enact_capability
//   (c) write a one-paragraph README snippet — light mechanical work → DOWN to haiku

/** The single user turn the coordinator drives from. */
export const COORDINATION_TASK =
  'You are coordinating the build of a design system from the GOV.UK palette ' +
  '(green #00703c, red #d4351c, blue #1d70b8, black #0b0c0c, mid-grey #505a5f). ' +
  'Three pieces of work: (a) **decide the token architecture and naming scheme** — ' +
  'a hard design-reasoning judgement; (b) **extract the full token set as DTCG JSON** — ' +
  'capability-shaped production; (c) **write a one-paragraph README snippet** describing ' +
  'the palette — light mechanical work. You have `enact_capability`, `delegate`, `dispatch` ' +
  '(each takes a `model` override — opus is the reasoning tier, haiku the light tier), and ' +
  '`read_file`/`write_file`. Coordinate: route each piece to where it belongs, then report ' +
  'what you did.';
