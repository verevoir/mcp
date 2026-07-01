import { describe, it, expect } from 'vitest';
import { score, isRunFailure, expectedToolLabel } from '../src/tool-discovery/score.js';
import { routeFailureKind } from '../src/tool-discovery/report.js';
import { TASKS, type Task } from '../src/tool-discovery/tasks.js';
import type { CellResult } from '../src/tool-discovery/run.js';

// Scoring only — the model calls are network and are not unit-tested. These pin
// the verdict rules: route tasks pass on a routing tool (and the pinned one when
// set) and fail on a native-shell defection (run_shell) or a self-inline produce
// (write_file / edit_file), naming which; inline tasks pass on any non-routing
// move (native included) and fail on over-delegation; run failures score as
// no-verdict.

const byId = (id: string): Task => {
  const t = TASKS.find((task) => task.id === id);
  if (!t) throw new Error(`no fixture task "${id}"`);
  return t;
};

describe('score — route tasks', () => {
  it('passes when a capability task routes via its pinned enact_capability', () => {
    expect(score('enact_capability', byId('capability'))).toMatchObject({ pass: true });
  });

  it('fails a capability task that routes via a non-pinned routing tool', () => {
    // delegate IS a routing tool, but the capability task pins enact_capability.
    expect(score('delegate', byId('capability'))).toMatchObject({ pass: false });
  });

  it('fails a capability task self-generated inline, naming self-inline', () => {
    const s = score('write_file', byId('capability'));
    expect(s.pass).toBe(false);
    expect(s.reason).toMatch(/self-produced inline/);
  });

  it('fails a capability task defected to the native shell, naming native', () => {
    const s = score('run_shell', byId('capability'));
    expect(s.pass).toBe(false);
    expect(s.reason).toMatch(/native shell/);
  });

  it('passes a bulk task via delegate (no pinned tool — any routing tool)', () => {
    expect(score('delegate', byId('bulk'))).toMatchObject({ pass: true });
  });

  it('passes a bulk task via dispatch', () => {
    expect(score('dispatch', byId('bulk'))).toMatchObject({ pass: true });
  });

  it('fails a bulk task the model wrote itself inline', () => {
    expect(score('write_file', byId('bulk'))).toMatchObject({ pass: false });
  });

  it('fails a bulk task defected to the native shell, naming native', () => {
    const s = score('run_shell', byId('bulk'));
    expect(s.pass).toBe(false);
    expect(s.reason).toMatch(/native shell/);
  });

  it('distinguishes native-shell defection from self-inline on a route task', () => {
    expect(score('run_shell', byId('bulk')).reason).toMatch(/native shell/);
    expect(score('write_file', byId('bulk')).reason).toMatch(/self-produced inline/);
  });

  it('passes the coupled task via any routing tool rather than self-generating', () => {
    expect(score('enact_capability', byId('coupled'))).toMatchObject({ pass: true });
    expect(score('delegate', byId('coupled'))).toMatchObject({ pass: true });
  });

  it('fails the coupled task when the model self-generates for consistency', () => {
    expect(score('write_file', byId('coupled'))).toMatchObject({ pass: false });
    expect(score('none', byId('coupled'))).toMatchObject({ pass: false });
  });
});

describe('score — read tasks (the fetch-defection probe)', () => {
  it('fails when the model shells out to fetch — the wild defection', () => {
    const s = score('run_shell', byId('read'));
    expect(s.pass).toBe(false);
    expect(s.reason).toMatch(/native shell/i);
  });

  it('passes when the model sources through the substrate (read_file / grep)', () => {
    expect(score('read_file', byId('read'))).toMatchObject({ pass: true });
    expect(score('grep', byId('read'))).toMatchObject({ pass: true });
  });

  it('passes when the model routes the whole task (which reads internally)', () => {
    expect(score('enact_capability', byId('read'))).toMatchObject({ pass: true });
    expect(score('delegate', byId('read'))).toMatchObject({ pass: true });
  });

  it('fails a non-read, non-routing first move (e.g. self-producing without sourcing)', () => {
    expect(score('write_file', byId('read'))).toMatchObject({ pass: false });
  });
});

describe('score — inline tasks', () => {
  it('passes a surgical edit kept inline via edit_file', () => {
    expect(score('edit_file', byId('surgical'))).toMatchObject({ pass: true });
  });

  it('passes a surgical edit kept inline via write_file', () => {
    expect(score('write_file', byId('surgical'))).toMatchObject({ pass: true });
  });

  it('passes a surgical edit answered in plain text (none)', () => {
    expect(score('none', byId('surgical'))).toMatchObject({ pass: true });
  });

  it('fails a surgical edit that was over-delegated to a routing tool', () => {
    expect(score('delegate', byId('surgical'))).toMatchObject({ pass: false });
    expect(score('enact_capability', byId('surgical'))).toMatchObject({ pass: false });
  });

  it('passes reading/grepping before a surgical edit — inspection is not over-delegation', () => {
    // read-before-edit is the correct first step; only a routing tool should fail
    // the inline verdict (STDIO-517 scoring fix).
    expect(score('read_file', byId('surgical'))).toMatchObject({ pass: true });
    expect(score('grep', byId('surgical'))).toMatchObject({ pass: true });
  });

  it('passes a surgical edit made via the native shell — native is fine inline', () => {
    // STDIO-520: run_shell is a defection only on route tasks; for a surgical
    // edit the native shell is a legitimate inline move, not over-delegation.
    expect(score('run_shell', byId('surgical'))).toMatchObject({ pass: true });
  });
});

describe('score — run failures score as no-verdict', () => {
  it('does not pass an unsupported cell', () => {
    expect(score('unsupported', byId('capability'))).toMatchObject({ pass: false });
    expect(score('unsupported', byId('capability')).reason).toContain('unsupported');
  });

  it('does not pass an errored cell, keeping the error in the reason', () => {
    const s = score('error:boom', byId('surgical'));
    expect(s.pass).toBe(false);
    expect(s.reason).toContain('error:boom');
  });
});

describe('isRunFailure', () => {
  it('flags unsupported and error sentinels, not real moves', () => {
    expect(isRunFailure('unsupported')).toBe(true);
    expect(isRunFailure('error:whatever')).toBe(true);
    expect(isRunFailure('none')).toBe(false);
    expect(isRunFailure('delegate')).toBe(false);
    expect(isRunFailure('write_file')).toBe(false);
  });
});

describe('expectedToolLabel', () => {
  it('names the pinned tool for a capability task', () => {
    expect(expectedToolLabel(byId('capability'))).toBe('enact_capability');
  });

  it('names the routing family for an unpinned route task', () => {
    expect(expectedToolLabel(byId('bulk'))).toContain('enact_capability');
  });

  it('names an inline tool for an inline task', () => {
    expect(expectedToolLabel(byId('surgical'))).toContain('write_file');
  });
});

describe('routeFailureKind — which way a route failure went', () => {
  const cell = (firstMove: string): CellResult => ({
    model: 'm',
    taskId: 'capability',
    firstMove,
    score: score(firstMove, byId('capability')),
  });

  it('classifies a run_shell first move as a native-shell defection', () => {
    expect(routeFailureKind(cell('run_shell'))).toBe('native');
  });

  it('classifies a write_file / edit_file first move as self-inline', () => {
    expect(routeFailureKind(cell('write_file'))).toBe('self');
    expect(routeFailureKind(cell('edit_file'))).toBe('self');
  });

  it('classifies any other non-routing miss as other', () => {
    expect(routeFailureKind(cell('none'))).toBe('other');
  });
});
