import { describe, it, expect } from 'vitest';
import { score, isRunFailure, expectedToolLabel } from '../src/tool-discovery/score.js';
import { TASKS, type Task } from '../src/tool-discovery/tasks.js';

// Scoring only — the model calls are network and are not unit-tested. These pin
// the verdict rules: route tasks pass on a routing tool (and the pinned one when
// set); inline tasks pass on a non-routing move and fail on over-delegation; run
// failures score as no-verdict.

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

  it('fails a capability task self-generated inline', () => {
    expect(score('write_file', byId('capability'))).toMatchObject({ pass: false });
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

  it('passes the coupled task via any routing tool rather than self-generating', () => {
    expect(score('enact_capability', byId('coupled'))).toMatchObject({ pass: true });
    expect(score('delegate', byId('coupled'))).toMatchObject({ pass: true });
  });

  it('fails the coupled task when the model self-generates for consistency', () => {
    expect(score('write_file', byId('coupled'))).toMatchObject({ pass: false });
    expect(score('none', byId('coupled'))).toMatchObject({ pass: false });
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
