// STDIO-517 / STDIO-520 — Tool-discovery eval: the task fixture.
//
// Four tasks, each with an expected routing VERDICT. The eval measures ONE
// thing: given our MCP tools + the injected steer, does a reasoning model route
// the work to a routing tool (enact_capability / delegate / dispatch) when it
// should, and keep it inline (write_file / edit_file / plain text) when it
// should — or does it self-generate big work (inline OR via the native shell)
// and over-delegate small work?
//
// The `route` tasks supply their needed data INLINE so no fetch is required:
// the model's FIRST move is the produce-routing decision itself, not a
// read/shell to gather source. Without this a model could legitimately
// run_shell/read to fetch first, and the first move wouldn't be the decision
// the eval is measuring.
//
// - `route`   → the model should hand the work off. `expectTool`, when set,
//   pins the specific routing tool the task most wants (enact_capability for
//   capability-shaped work); left unset, any routing tool passes. Producing it
//   itself — inline (write_file) or native (run_shell) — is a defection.
// - `inline`  → the model should just do it: a small surgical edit is NOT
//   delegation-shaped, and reaching for a routing tool here is over-delegation.
//   Native (run_shell) is a fine way to make a surgical edit.
// - `read`    → the model MUST fetch source first. This is the wild-defection
//   point: it should read through the substrate (read_file / grep) or route the
//   whole task (enact/delegate reads internally), NOT shell out (run_shell /
//   curl). The wild run showed a model happily routing PRODUCTION but defecting
//   to native shell for the FETCH — this task isolates that choice.

/** The routing tools — handing work OFF to a governed/tiered path. */
export const ROUTING_TOOLS = ['enact_capability', 'delegate', 'dispatch'] as const;

/** The inline tools — doing the work in-host, no routing. `none` (a plain text
 * reply, no tool call) also counts as inline: the model chose not to route. */
export const INLINE_TOOLS = ['write_file', 'edit_file'] as const;

export type Verdict = 'route' | 'inline' | 'read';

export interface Task {
  /** Stable id — the matrix column and the test key. */
  id: string;
  /** The prompt the model sees (the user turn). */
  prompt: string;
  /** Whether the work should be routed off or kept inline. */
  verdict: Verdict;
  /** For a `route` task, the specific routing tool expected; unset ⇒ any
   * routing tool passes. Ignored for `inline` tasks. */
  expectTool?: (typeof ROUTING_TOOLS)[number];
  /** One line on what this task is probing, for the report. */
  note: string;
}

export const TASKS: Task[] = [
  {
    id: 'capability',
    prompt:
      'Here is the GOV.UK Design System core palette — green #00703c, red #d4351c, ' +
      'blue #1d70b8, black #0b0c0c, mid-grey #505a5f. Produce the DTCG design-token ' +
      'set for these values.',
    verdict: 'route',
    expectTool: 'enact_capability',
    note: 'Capability-shaped work, values supplied inline so no fetch is needed — the FIRST move is the produce-routing decision. Should go through enact_capability (governed + verified), not be hand-written or shelled out.',
  },
  {
    id: 'bulk',
    prompt:
      'Scaffold eight boilerplate config files (eslint, prettier, tsconfig, CI, Dockerfile, …) for a new TypeScript service.',
    verdict: 'route',
    note: 'Free-form bulk — should be delegated / dispatched to a cheaper tier, not self-generated.',
  },
  {
    id: 'coupled',
    prompt:
      'Using this shared design-token vocabulary — colour.brand #00703c, colour.text ' +
      '#0b0c0c, space.sm 8px, space.md 16px, font.body "GDS Transport" — produce three ' +
      'example sites (Node, Java, .NET) that all consume it.',
    verdict: 'route',
    note: 'Coupled generation — the trap. Vocabulary supplied inline so no fetch is needed; the shared vocabulary is the SIGNAL to decompose and route, not to self-generate (or shell out) for consistency.',
  },
  {
    id: 'surgical',
    prompt: 'Rename the variable `foo` to `bar` in one file.',
    verdict: 'inline',
    note: 'A small surgical edit — should stay inline (write_file / edit_file / plain text). Routing it is over-delegation.',
  },
  {
    id: 'read',
    prompt:
      'Please look at the uk.gov design system, I’d like you to extract a token set ' +
      'and generate example sites in node, java and .net.',
    verdict: 'read',
    note: 'The real wild prompt, left open so the model must decide HOW to source the design system — the fetch-defection point. Should read source through the substrate (read_file / grep) or route the whole task (enact/delegate), NOT shell out with run_shell / curl. (The wild run showed a model routing production but defecting to native shell for the fetch.)',
  },
];
