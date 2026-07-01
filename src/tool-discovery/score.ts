// STDIO-517 — Tool-discovery eval: scoring. PURE — no I/O, no model calls, so
// the whole verdict logic is unit-testable without a network.

import { ROUTING_TOOLS, type Task } from './tasks.js';
import { NATIVE_TOOLS } from './tools.js';

/** The self-produce inline tools — the model writing the work itself in-host
 * rather than routing it. On a `route` task these are a defection, distinct
 * from the native-shell one. */
const SELF_PRODUCE_TOOLS = ['write_file', 'edit_file'] as const;

/** The substrate read tools — fetching source THROUGH the shared cache/index
 * rather than shelling out. On a `read` task these (or a routing tool that reads
 * internally) are the correct move; `run_shell` is the native-fetch defection. */
const SUBSTRATE_READ_TOOLS = ['read_file', 'grep'] as const;

/** The model's first move: the name of the first tool it reached for, `'none'`
 * when it answered in plain text (no tool call), or a run-status sentinel
 * (`'unsupported'` / `'error:<msg>'`) the runner records instead of a move. */
export type FirstMove = string;

/** `'none'` is a real, expected first move (a plain-text reply — the model
 * chose not to call any tool). The sentinels below are NOT moves: they mean the
 * call never produced one, so the cell can't pass or fail on routing. */
export function isRunFailure(firstMove: FirstMove): boolean {
  return firstMove === 'unsupported' || firstMove.startsWith('error:');
}

function isRoutingTool(firstMove: FirstMove): boolean {
  return (ROUTING_TOOLS as readonly string[]).includes(firstMove);
}

function isNativeTool(firstMove: FirstMove): boolean {
  return (NATIVE_TOOLS as readonly string[]).includes(firstMove);
}

function isSelfProduceTool(firstMove: FirstMove): boolean {
  return (SELF_PRODUCE_TOOLS as readonly string[]).includes(firstMove);
}

function isSubstrateReadTool(firstMove: FirstMove): boolean {
  return (SUBSTRATE_READ_TOOLS as readonly string[]).includes(firstMove);
}

export interface Score {
  pass: boolean;
  /** Why it passed / failed, in one line — for the matrix + failures section. */
  reason: string;
}

/**
 * Score a first move against a task's expected verdict. PURE.
 *
 * - `route`  → pass iff the first move routes to the substrate (enact_capability
 *   / delegate / dispatch). When the task pins an `expectTool`, the SPECIFIC tool
 *   must match (capability work wants enact_capability, not a bare delegate).
 *   Two kinds of miss are distinguished because they point at different fixes:
 *   a native move (run_shell) is a DEFECTION to the native shell — the wild
 *   finding; a self-produce move (write_file / edit_file) is producing the work
 *   INLINE. Both fail, and the reason names which way it went.
 * - `read`   → the fetch-defection probe. Sourcing MUST go through the substrate
 *   (read_file / grep, or a routing tool that reads internally); `run_shell` is
 *   the native-fetch defection the wild run exposed (production routed fine, the
 *   fetch shelled out).
 * - `inline` → pass iff the first move is NOT a routing tool. The test is
 *   "didn't over-DELEGATE" — so any coordinator-local move passes (write_file,
 *   edit_file, read_file, grep, run_shell, a plain reply), and only reaching for
 *   enact_capability / delegate / dispatch on small work fails. Native (run_shell)
 *   is a fine way to make a surgical edit; reading or grepping first is the
 *   correct step, not a miss.
 *
 * A run failure (unsupported / error) can neither pass nor fail on routing; it
 * returns `pass: false` with the status as the reason so the matrix shows why
 * the cell is blank rather than silently scoring it as a miss.
 */
export function score(firstMove: FirstMove, task: Task): Score {
  if (isRunFailure(firstMove)) {
    return { pass: false, reason: `no verdict — ${firstMove}` };
  }

  if (task.verdict === 'route') {
    if (isNativeTool(firstMove)) {
      return { pass: false, reason: `defected to native shell — ${firstMove}, expected routing` };
    }
    if (isSelfProduceTool(firstMove)) {
      return { pass: false, reason: `self-produced inline — ${firstMove}, expected routing` };
    }
    if (!isRoutingTool(firstMove)) {
      return { pass: false, reason: `expected a routing tool, got ${firstMove}` };
    }
    if (task.expectTool && firstMove !== task.expectTool) {
      return { pass: false, reason: `expected ${task.expectTool}, got ${firstMove}` };
    }
    return { pass: true, reason: `routed via ${firstMove}` };
  }

  if (task.verdict === 'read') {
    // The fetch-defection probe: sourcing must go THROUGH the substrate (a read
    // tool, or a routing tool that reads internally); shelling out is the miss.
    if (isNativeTool(firstMove)) {
      return {
        pass: false,
        reason: `defected to native shell for the fetch — ${firstMove}, expected a substrate read`,
      };
    }
    if (isSubstrateReadTool(firstMove) || isRoutingTool(firstMove)) {
      return { pass: true, reason: `sourced via the substrate (${firstMove})` };
    }
    return {
      pass: false,
      reason: `expected a substrate read (read_file / grep) or routing, got ${firstMove}`,
    };
  }

  // verdict === 'inline' — the test is "didn't over-delegate", so only a routing
  // tool fails; every coordinator-local move (read/grep/edit/write/run_shell/plain
  // reply) keeps it inline, native included.
  if (isRoutingTool(firstMove)) {
    return { pass: false, reason: `over-delegated — routed via ${firstMove}, expected inline` };
  }
  return {
    pass: true,
    reason: firstMove === 'none' ? 'kept inline (plain reply)' : `kept inline (${firstMove})`,
  };
}

/** For a FAILED route task, the tool the model was expected to reach for — the
 * `expectTool` when pinned, else the routing family. Used to phrase the candid
 * follow-up asked of a model that routed wrong. */
export function expectedToolLabel(task: Task): string {
  if (task.verdict === 'inline') return 'an inline tool (write_file / edit_file)';
  return task.expectTool ?? `a routing tool (${ROUTING_TOOLS.join(' / ')})`;
}
