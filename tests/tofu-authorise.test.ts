import { describe, it, expect } from 'vitest';
import { classifyPlan } from '../src/tofu/plan.js';
import { authoriseApply } from '../src/tofu/authorise.js';

/** Build a classified plan from (address, actions) pairs. */
function classified(...changes: [string, string[]][]) {
  return classifyPlan({
    resource_changes: changes.map(([address, actions]) => ({ address, change: { actions } })),
  });
}

describe('authoriseApply (STDIO-414 — gate: destructive)', () => {
  it('authorises an additive plan regardless of the authorised set — this gate is for destruction only', () => {
    const r = authoriseApply(classified(['a', ['create']], ['b', ['update']]), []);
    expect(r.authorised).toBe(true);
  });

  it('authorises a destructive plan when every destroyed/replaced resource is acknowledged', () => {
    const plan = classified(['db.main', ['delete']], ['svc.app', ['delete', 'create']]);
    const r = authoriseApply(plan, ['db.main', 'svc.app']);
    expect(r.authorised).toBe(true);
    expect(r.unauthorised).toEqual([]);
    expect(r.stale).toEqual([]);
  });

  it('is order-independent — the acknowledged set need not match the plan order', () => {
    const plan = classified(['db.main', ['delete']], ['svc.app', ['delete', 'create']]);
    expect(authoriseApply(plan, ['svc.app', 'db.main']).authorised).toBe(true);
  });

  it('refuses when a destructive resource is not authorised, naming it', () => {
    const plan = classified(['db.main', ['delete']], ['svc.app', ['delete']]);
    const r = authoriseApply(plan, ['db.main']); // svc.app not acknowledged
    expect(r.authorised).toBe(false);
    expect(r.unauthorised).toEqual(['svc.app']);
  });

  it('a blanket empty authorisation cannot apply a destructive plan', () => {
    const plan = classified(['db.main', ['delete']]);
    const r = authoriseApply(plan, []);
    expect(r.authorised).toBe(false);
    expect(r.unauthorised).toEqual(['db.main']);
  });

  it('refuses when the authorisation names a resource the plan no longer destroys (plan drifted)', () => {
    const plan = classified(['db.main', ['delete']]);
    const r = authoriseApply(plan, ['db.main', 'old.gone']); // old.gone not in this plan
    expect(r.authorised).toBe(false);
    expect(r.stale).toEqual(['old.gone']);
    expect(r.reason).toMatch(/re-authorise/);
  });
});
