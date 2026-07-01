// STDIO-521 — coordinator cost×quality harness: the quality gate + checklist.
//
// After a run, the harness pulls the produced DTCG token JSON out of the
// workspace / enact result and judges it two ways:
//   - the deterministic `@verevoir/design-gate` `verifyFiles` — DTCG validity +
//     value-drift, the same shared gate `enact_capability` enforces; and
//   - a done-well CHECKLIST over the parsed tokens — the semantic/alias layer,
//     and the colour / type / space dimensions the maximal task asked for.
//
// The checklist logic is PURE over a parsed token object, so it is unit-testable
// without a network. `verifyFiles` / `renderTokenView` are the shared gate; they
// run on real produced output, not in the unit tests.

import { verifyFiles, renderTokenView } from '@verevoir/design-gate';
import { extractTokenJson } from '../tools/design-gate.js';

/** One done-well check over the produced token set: what it looks for, and
 * whether the output met it. */
export interface ChecklistItem {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
}

/** The whole quality verdict for a run: the deterministic gate result and the
 * done-well checklist, plus the overall pass (gate green AND every check met). */
export interface QualityVerdict {
  /** True when a DTCG token file was found in the run's output at all. */
  foundTokens: boolean;
  /** The deterministic gate: DTCG-valid, no value-drift, drift-gate emitted. */
  gateOk: boolean;
  /** The gate's findings ({@link @verevoir/design-gate} `verifyFiles`), for the report. */
  gateFindings: string[];
  checklist: ChecklistItem[];
  /** Passes only when a token file was found, the gate is green, and every
   * checklist item is met. */
  passes: boolean;
}

/** A DTCG group is any nested object; a DTCG token is a group carrying a
 * `$value`. Walk the tree collecting every token with its `$type` (inherited
 * from the nearest ancestor `$type`, per DTCG). */
interface FoundToken {
  path: string;
  type: string | undefined;
  value: unknown;
  raw: Record<string, unknown>;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Collect every DTCG token in a parsed token object, carrying the inherited
 * `$type`. Pure tree-walk; unknown shapes yield no tokens rather than throwing. */
export function collectTokens(root: unknown): FoundToken[] {
  const found: FoundToken[] = [];
  const walk = (node: unknown, path: string, inheritedType: string | undefined): void => {
    if (!isObject(node)) return;
    const type = typeof node.$type === 'string' ? node.$type : inheritedType;
    if ('$value' in node) {
      found.push({ path, type, value: node.$value, raw: node });
      return;
    }
    for (const [key, child] of Object.entries(node)) {
      if (key.startsWith('$')) continue;
      walk(child, path ? `${path}.${key}` : key, type);
    }
  };
  walk(root, '', undefined);
  return found;
}

/** Whether any token's `$value` is an alias reference — DTCG aliases are
 * `{token.path}` strings, so a semantic layer pointing at primitives shows up as
 * brace-wrapped values. */
function hasAliasLayer(tokens: FoundToken[]): boolean {
  return tokens.some((t) => typeof t.value === 'string' && /^\{.+\}$/.test(t.value.trim()));
}

/** Whether the token set covers a dimension, by DTCG `$type`. Colour tokens are
 * `color`; type is `typography` / `fontFamily` / `fontSize` / `fontWeight`;
 * space is `dimension` / `spacing`. */
function coversType(tokens: FoundToken[], types: string[]): boolean {
  const wanted = new Set(types);
  return tokens.some((t) => t.type !== undefined && wanted.has(t.type));
}

/** The done-well checklist over a parsed token object. PURE. Each item states
 * what a maximal, well-formed token set should have: a semantic/alias layer, and
 * colour / type / space dimensions. */
export function buildChecklist(root: unknown): ChecklistItem[] {
  const tokens = collectTokens(root);
  const colours = tokens.filter((t) => t.type === 'color').length;
  return [
    {
      id: 'has-tokens',
      label: 'contains DTCG tokens',
      ok: tokens.length > 0,
      detail: `${tokens.length} token(s) found`,
    },
    {
      id: 'alias-layer',
      label: 'semantic / alias layer present',
      ok: hasAliasLayer(tokens),
      detail: hasAliasLayer(tokens)
        ? 'at least one token aliases another'
        : 'no {alias} references — flat primitives only',
    },
    {
      id: 'colour-dimension',
      label: 'colour dimension covered',
      ok: coversType(tokens, ['color']),
      detail: `${colours} color token(s)`,
    },
    {
      id: 'type-dimension',
      label: 'type dimension covered',
      ok: coversType(tokens, [
        'typography',
        'fontFamily',
        'fontFamilies',
        'fontSize',
        'fontWeight',
      ]),
      detail: coversType(tokens, [
        'typography',
        'fontFamily',
        'fontFamilies',
        'fontSize',
        'fontWeight',
      ])
        ? 'typography tokens present'
        : 'no typography / font tokens',
    },
    {
      id: 'space-dimension',
      label: 'space dimension covered',
      ok: coversType(tokens, ['dimension', 'spacing', 'space', 'sizing']),
      detail: coversType(tokens, ['dimension', 'spacing', 'space', 'sizing'])
        ? 'dimension / spacing tokens present'
        : 'no dimension / spacing tokens',
    },
  ];
}

/** Render the deterministic gate findings as short lines, matching the shape the
 * design-gate emits (`KIND where: message`). */
function renderGateFindings(
  findings: { kind: string; where?: string; message: string }[]
): string[] {
  return findings.map((f) => `${f.kind}${f.where ? ` ${f.where}` : ''}: ${f.message}`);
}

/**
 * Judge a run's produced output: extract the DTCG token JSON, run the shared
 * `verifyFiles` gate over the pack (token file + its generated view), and build
 * the done-well checklist over the parsed tokens. Returns a verdict with no
 * token file found reading as `foundTokens: false` rather than throwing — a
 * coordinator that never produced a token set is a legible fail, not a crash.
 *
 * The generated view is rendered here (as `design-pack`'s verifier does) so
 * VIEW_DRIFT can't fire on a generation step — the gate's force is DTCG validity
 * and value-drift, the drift-gate the capability declares.
 */
export function judgeQuality(producedText: string): QualityVerdict {
  const json = extractTokenJson(producedText);
  if (!json) {
    return {
      foundTokens: false,
      gateOk: false,
      gateFindings: ['no DTCG token JSON found in the run output'],
      checklist: [],
      passes: false,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    return {
      foundTokens: false,
      gateOk: false,
      gateFindings: [`token JSON did not parse: ${String(err).slice(0, 120)}`],
      checklist: [],
      passes: false,
    };
  }

  const tokenPath = 'design-language/tokens/coordinator-cost.tokens.json';
  const viewPath = tokenPath.replace(/\.json$/, '.md');
  let view = '';
  try {
    view = renderTokenView(parsed);
  } catch {
    // parsed already succeeded, so a render failure just yields an empty view
    // (a VIEW_DRIFT finding, not a throw).
  }
  const gate = verifyFiles({ [tokenPath]: json, [viewPath]: view });
  const checklist = buildChecklist(parsed);
  const passes = gate.ok && checklist.every((c) => c.ok);

  return {
    foundTokens: true,
    gateOk: gate.ok,
    gateFindings: gate.ok ? [] : renderGateFindings(gate.findings),
    checklist,
    passes,
  };
}
