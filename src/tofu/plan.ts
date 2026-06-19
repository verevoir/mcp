// OpenTofu / Terraform plan classifier (STDIO-413, slice 1).
//
// Parses a `tofu show -json <planfile>` document and classifies every resource
// change, so the provisioning tools and the gitops workflow can see — and lead
// with — the BLAST RADIUS of a plan before anything is applied. Destructive
// changes (a resource deleted, or replaced = deleted-and-recreated) are the
// highest-blast-radius thing the tool can do; they get their own count and the
// exact set of addresses, which a heavier, itemised authorisation must match
// before `tofu apply` will touch them (STDIO-414).
//
// FAIL CLOSED: a plan we can't parse or understand is NEVER reported as "no
// destructive changes". `classifyPlan` throws on a malformed plan or an
// unclassifiable change, so a caller can't mistake "couldn't read it" for
// "safe". The unsafe default — silently treating a broken plan as additive —
// is exactly what this rules out.

/** The kind of change Tofu will make to one resource. */
export type ChangeKind = 'create' | 'update' | 'replace' | 'destroy' | 'read' | 'no-op';

/** One resource's planned change, reduced to its address and kind. */
export interface ResourceChange {
  address: string;
  kind: ChangeKind;
}

/** The classified plan: counts per kind, the exact destructive set, and the
 * single `destructive` flag that triggers heavier authorisation. */
export interface PlanClassification {
  changes: ResourceChange[];
  creates: number;
  updates: number;
  replaces: string[];
  destroys: string[];
  reads: number;
  noops: number;
  /** True when the plan deletes or replaces any resource — the trigger for the
   * itemised, heavier authorisation (STDIO-414). */
  destructive: boolean;
  /** The exact resource addresses that will be torn down (destroys + replaces).
   * An itemised destructive authorisation must match this set exactly. */
  destructiveAddresses: string[];
}

/** Map a Tofu `change.actions` array to a single change kind. The documented
 * action sets are `["no-op"]`, `["read"]`, `["create"]`, `["update"]`,
 * `["delete"]`, and a replace as `["delete","create"]` or `["create","delete"]`.
 * Anything containing `delete` is destructive. Throws on an unrecognisable set
 * rather than guess (fail closed). */
function classifyActions(actions: unknown, address: string): ChangeKind {
  if (
    !Array.isArray(actions) ||
    actions.length === 0 ||
    !actions.every((a) => typeof a === 'string')
  ) {
    throw new Error(
      `tofu plan: resource "${address}" has no readable change.actions — cannot classify`
    );
  }
  const set = actions as string[];
  const has = (a: string) => set.includes(a);
  if (set.length === 1 && set[0] === 'no-op') return 'no-op';
  if (set.length === 1 && set[0] === 'read') return 'read';
  if (has('delete') && has('create')) return 'replace';
  if (has('delete')) return 'destroy';
  if (has('create')) return 'create';
  if (has('update')) return 'update';
  throw new Error(`tofu plan: resource "${address}" has unrecognised actions [${set.join(', ')}]`);
}

/** Classify a `tofu show -json` plan. Accepts the parsed object or its JSON
 * string. Throws (fail closed) on anything it can't parse or classify, so a
 * malformed plan is never mistaken for a safe one. */
export function classifyPlan(plan: unknown): PlanClassification {
  let doc: unknown = plan;
  if (typeof plan === 'string') {
    try {
      doc = JSON.parse(plan);
    } catch (e) {
      throw new Error(`tofu plan: not valid JSON — ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (typeof doc !== 'object' || doc === null) {
    throw new Error('tofu plan: expected a JSON object');
  }
  const raw = (doc as { resource_changes?: unknown }).resource_changes;
  if (raw !== undefined && !Array.isArray(raw)) {
    throw new Error('tofu plan: `resource_changes` is present but not an array');
  }
  const entries = (raw ?? []) as unknown[];

  const changes: ResourceChange[] = [];
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error('tofu plan: a resource_changes entry is not an object');
    }
    const address = (entry as { address?: unknown }).address;
    if (typeof address !== 'string' || address === '') {
      throw new Error('tofu plan: a resource_changes entry has no address');
    }
    const change = (entry as { change?: unknown }).change;
    const actions = (change as { actions?: unknown } | undefined)?.actions;
    changes.push({ address, kind: classifyActions(actions, address) });
  }

  const destroys = changes.filter((c) => c.kind === 'destroy').map((c) => c.address);
  const replaces = changes.filter((c) => c.kind === 'replace').map((c) => c.address);
  const destructiveAddresses = [...destroys, ...replaces];
  return {
    changes,
    creates: changes.filter((c) => c.kind === 'create').length,
    updates: changes.filter((c) => c.kind === 'update').length,
    replaces,
    destroys,
    reads: changes.filter((c) => c.kind === 'read').length,
    noops: changes.filter((c) => c.kind === 'no-op').length,
    destructive: destructiveAddresses.length > 0,
    destructiveAddresses,
  };
}

/** A human-facing summary that LEADS with the blast radius — a destructive plan
 * shouts, an additive one reads clean. Listed destructive addresses are the
 * exact set an apply must be authorised against. */
export function renderPlanSummary(c: PlanClassification): string {
  const lines: string[] = [];
  if (c.destructive) {
    const bits: string[] = [];
    if (c.destroys.length) bits.push(`DESTROYS ${c.destroys.length}`);
    if (c.replaces.length) bits.push(`REPLACES ${c.replaces.length}`);
    lines.push(`⚠ DESTRUCTIVE — this plan ${bits.join(' and ')}:`);
    for (const address of c.destructiveAddresses) lines.push(`  - ${address}`);
    lines.push('Applying requires itemised authorisation of exactly these resources.');
    lines.push('');
  }
  lines.push(
    `Plan: ${c.creates} to add, ${c.updates} to change, ${c.replaces.length} to replace, ${c.destroys.length} to destroy.`
  );
  return lines.join('\n');
}
