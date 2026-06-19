// Destructive-apply authorisation (STDIO-414, the `gate: destructive` tier).
//
// A destructive Tofu apply (anything that deletes or replaces a resource) is the
// highest-blast-radius action the tool can take, so it needs not a *louder* yes
// but a *more specific* one: the approver must acknowledge the EXACT resources
// being torn down, and the apply may proceed only if that itemised
// authorisation matches the plan's destructive set. This is the decision core
// the `tofu_apply` tool and the provision gitops workflow enforce — separately,
// so the gate can't be the only thing between a stray plan and a dropped
// database.
//
// FAIL CLOSED on drift: if the plan names a destructive resource the
// authorisation didn't cover, OR the authorisation names a resource the plan no
// longer touches (the plan changed under the approval), apply is REFUSED. A
// blanket "yes" can't authorise a destructive apply, and a yes given against a
// different plan can't either.

import type { PlanClassification } from './plan.js';

/** The outcome of authorising an apply against an itemised destructive ack. */
export interface ApplyAuthorisation {
  /** Whether the apply may proceed. */
  authorised: boolean;
  /** Destructive addresses in the plan that the authorisation did not cover. */
  unauthorised: string[];
  /** Authorised addresses that the current plan does not destroy — a sign the
   * plan drifted since the approval was given. */
  stale: string[];
  /** A legible reason, safe to surface to a human or a log. */
  reason: string;
}

/**
 * Decide whether an apply may proceed given the plan's classification and the
 * set of resource addresses a human explicitly authorised for destruction.
 *
 * - A plan with **no** destructive changes is always authorised (additive /
 *   in-place applies run under the normal assent gate, not this one).
 * - A destructive plan proceeds **only** if the authorised set matches the
 *   plan's destructive set **exactly**: every destroyed/replaced resource is
 *   authorised (no `unauthorised`), and the authorisation names nothing the plan
 *   doesn't touch (no `stale`). Either kind of mismatch refuses the apply.
 */
export function authoriseApply(
  plan: PlanClassification,
  authorisedAddresses: string[]
): ApplyAuthorisation {
  if (!plan.destructive) {
    return {
      authorised: true,
      unauthorised: [],
      stale: [],
      reason: 'no destructive changes — additive/in-place apply needs no destructive authorisation',
    };
  }

  const authorised = new Set(authorisedAddresses);
  const planned = new Set(plan.destructiveAddresses);
  const unauthorised = plan.destructiveAddresses.filter((a) => !authorised.has(a));
  const stale = authorisedAddresses.filter((a) => !planned.has(a));

  if (unauthorised.length > 0) {
    return {
      authorised: false,
      unauthorised,
      stale,
      reason: `refused — ${unauthorised.length} destructive resource(s) not authorised: ${unauthorised.join(', ')}`,
    };
  }
  if (stale.length > 0) {
    return {
      authorised: false,
      unauthorised: [],
      stale,
      reason: `refused — the authorisation names ${stale.length} resource(s) this plan no longer destroys (${stale.join(', ')}); the plan changed under the approval, re-authorise against the current plan`,
    };
  }
  return {
    authorised: true,
    unauthorised: [],
    stale: [],
    reason: `authorised — all ${plan.destructiveAddresses.length} destructive resource(s) explicitly acknowledged`,
  };
}
