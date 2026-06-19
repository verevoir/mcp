import { describe, it, expect } from 'vitest';
import { classifyPlan, renderPlanSummary } from '../src/tofu/plan.js';

/** Build a `tofu show -json`-shaped plan from (address, actions) pairs. */
function plan(...changes: [string, string[]][]) {
  return {
    resource_changes: changes.map(([address, actions]) => ({ address, change: { actions } })),
  };
}

describe('classifyPlan (STDIO-413)', () => {
  it('classifies an additive plan as non-destructive', () => {
    const c = classifyPlan(plan(['google_cloud_run_service.app', ['create']]));
    expect(c.destructive).toBe(false);
    expect(c.creates).toBe(1);
    expect(c.destructiveAddresses).toEqual([]);
  });

  it('treats a delete as a destroy — destructive, with the address', () => {
    const c = classifyPlan(plan(['google_sql_database_instance.main', ['delete']]));
    expect(c.destructive).toBe(true);
    expect(c.destroys).toEqual(['google_sql_database_instance.main']);
    expect(c.destructiveAddresses).toEqual(['google_sql_database_instance.main']);
  });

  it('treats a delete+create as a replace — destructive', () => {
    const c = classifyPlan(plan(['google_sql_database_instance.main', ['delete', 'create']]));
    expect(c.destructive).toBe(true);
    expect(c.replaces).toEqual(['google_sql_database_instance.main']);
    expect(c.destroys).toEqual([]);
    expect(c.destructiveAddresses).toEqual(['google_sql_database_instance.main']);
  });

  it('treats create+delete (create-before-destroy) as a replace too', () => {
    const c = classifyPlan(plan(['x.y', ['create', 'delete']]));
    expect(c.replaces).toEqual(['x.y']);
    expect(c.destructive).toBe(true);
  });

  it('counts a mixed plan and collects the exact destructive set (destroys + replaces)', () => {
    const c = classifyPlan(
      plan(
        ['a.add', ['create']],
        ['b.change', ['update']],
        ['c.replace', ['delete', 'create']],
        ['d.gone', ['delete']],
        ['e.same', ['no-op']],
        ['f.data', ['read']]
      )
    );
    expect(c).toMatchObject({
      creates: 1,
      updates: 1,
      reads: 1,
      noops: 1,
      destructive: true,
    });
    expect(c.replaces).toEqual(['c.replace']);
    expect(c.destroys).toEqual(['d.gone']);
    expect(c.destructiveAddresses).toEqual(['d.gone', 'c.replace']);
  });

  it('an empty / no-change plan is non-destructive', () => {
    expect(classifyPlan({ resource_changes: [] }).destructive).toBe(false);
    expect(classifyPlan({}).destructive).toBe(false); // absent resource_changes = no changes
  });

  it('accepts the plan as a JSON string', () => {
    const c = classifyPlan(JSON.stringify(plan(['x.y', ['delete']])));
    expect(c.destructive).toBe(true);
  });

  // Fail closed — a plan we can't read must NEVER look like "no destructive changes".
  it('throws on invalid JSON rather than reading it as safe', () => {
    expect(() => classifyPlan('{not json')).toThrow(/not valid JSON/);
  });

  it('throws when resource_changes is present but not an array', () => {
    expect(() => classifyPlan({ resource_changes: 'nope' })).toThrow(/not an array/);
  });

  it('throws on a change with no readable actions rather than guessing it safe', () => {
    expect(() => classifyPlan({ resource_changes: [{ address: 'x.y', change: {} }] })).toThrow(
      /cannot classify/
    );
  });

  it('throws on an entry with no address', () => {
    expect(() => classifyPlan({ resource_changes: [{ change: { actions: ['create'] } }] })).toThrow(
      /no address/
    );
  });
});

describe('renderPlanSummary (STDIO-413)', () => {
  it('an additive plan reads clean — no destructive banner', () => {
    const s = renderPlanSummary(classifyPlan(plan(['a', ['create']], ['b', ['update']])));
    expect(s).not.toContain('⚠');
    expect(s).toContain('1 to add, 1 to change');
  });

  it('a destructive plan leads with the blast radius and lists the exact resources', () => {
    const s = renderPlanSummary(
      classifyPlan(plan(['db.main', ['delete']], ['svc.app', ['delete', 'create']]))
    );
    // Leads with the warning…
    expect(s.startsWith('⚠ DESTRUCTIVE')).toBe(true);
    expect(s).toContain('DESTROYS 1');
    expect(s).toContain('REPLACES 1');
    // …and names the exact resources an apply must be authorised against.
    expect(s).toContain('- db.main');
    expect(s).toContain('- svc.app');
    expect(s).toContain('itemised authorisation');
  });
});
