// STDIO-517 — Tool-discovery eval: the task fixture.
//
// Four tasks, each with an expected routing VERDICT. The eval measures ONE
// thing: given our MCP tools + the injected steer, does a reasoning model route
// the work to a routing tool (enact_capability / delegate / dispatch) when it
// should, and keep it inline (write_file / edit_file / plain text) when it
// should — or does it self-generate big work and over-delegate small work?
//
// - `route`   → the model should hand the work off. `expectTool`, when set,
//   pins the specific routing tool the task most wants (enact_capability for
//   capability-shaped work); left unset, any routing tool passes.
// - `inline`  → the model should just do it: a small surgical edit is NOT
//   delegation-shaped, and reaching for a routing tool here is over-delegation.

/** The routing tools — handing work OFF to a governed/tiered path. */
export const ROUTING_TOOLS = ['enact_capability', 'delegate', 'dispatch'] as const;

/** The inline tools — doing the work in-host, no routing. `none` (a plain text
 * reply, no tool call) also counts as inline: the model chose not to route. */
export const INLINE_TOOLS = ['write_file', 'edit_file'] as const;

export type Verdict = 'route' | 'inline';

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
    prompt: 'Generate the web design tokens for the GOV.UK Design System.',
    verdict: 'route',
    expectTool: 'enact_capability',
    note: 'Capability-shaped work — should go through enact_capability (governed + verified), not be hand-written.',
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
      'Generate three example sites (Node, Java, .NET) that all share one design-token vocabulary.',
    verdict: 'route',
    note: 'Coupled generation — the trap. The shared vocabulary is the SIGNAL to decompose and route, not to self-generate for consistency.',
  },
  {
    id: 'surgical',
    prompt: 'Rename the variable `foo` to `bar` in one file.',
    verdict: 'inline',
    note: 'A small surgical edit — should stay inline (write_file / edit_file / plain text). Routing it is over-delegation.',
  },
];
