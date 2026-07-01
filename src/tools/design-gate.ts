import type { Verifier } from '@verevoir/recipes/engine';
import { verifyFiles, renderTokenView } from '@verevoir/design-gate';

// STDIO-507 / STDIO-510 — the MCP runs a capability's own declared gate.
//
// `enact_capability` produces a gated capability on the worker tier, but a
// produce that is only practices-reviewed doesn't ENFORCE the deterministic
// check the capability declared (e.g. `design-pack`). A capability addressed as
// a tool has to carry its own verification — a tool validates its output, it
// doesn't leave that to the caller.
//
// STDIO-510: the gate is the SHARED, published `@verevoir/design-gate` package —
// "one source, two consumers": the same zero-dependency verifier the design
// capabilities emit into a produced pack (for that pack's CI) is the one the MCP
// imports here and the one aigency-web's executor imports. Not a second copy,
// not a corpus fetch — the same versioned artifact both runtimes depend on. So
// the gate fires regardless of how the corpus is sourced.

/** Pull the DTCG token JSON out of a worker's produced text — it may wrap the
 * file in a ```json fence or surround it with prose. Returns the first chunk
 * that parses as JSON, else null. */
export function extractTokenJson(text: string): string | null {
  const candidates: string[] = [];
  // EVERY fenced block, not just the first — a multi-part run's produced text
  // holds example-site code fences as well as the token set.
  for (const m of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    candidates.push(m[1].trim());
  }
  // EVERY top-level brace-balanced block, in order.
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          candidates.push(text.slice(i, j + 1));
          i = j; // resume scanning after this block, not inside it
          break;
        }
      }
    }
  }
  // Prefer a candidate that parses AND carries the DTCG markers ($value/$type):
  // a full run also emits example-site configs (package.json, tsconfig) that
  // parse as JSON but aren't the token set. Fall back to the first valid JSON so
  // a bare token set (no other JSON around) still resolves.
  let firstValid: string | null = null;
  for (const c of candidates) {
    try {
      JSON.parse(c);
    } catch {
      continue;
    }
    if (firstValid === null) firstValid = c;
    if (/"\$value"|"\$type"/.test(c)) return c;
  }
  return firstValid;
}

/** A corpus-safe file stem for the produced token file. */
function tokenStem(capabilityType: string): string {
  return (
    capabilityType
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'tokens'
  );
}

/** The `design-pack` verifier: extract the produced token JSON, build the
 * in-memory pack (the token file + its generated view) and run the shared
 * `@verevoir/design-gate` `verifyFiles` over it — returning the gate's verdict as
 * a VerifyResult that plugs straight into the produce→verify loop. The generated
 * view is rendered here (it isn't the worker's job to produce it), so VIEW_DRIFT
 * can't fire on a generation step; the gate's force is DTCG validity +
 * value-drift. */
export function designPackVerifier(capabilityType: string): Verifier {
  return async ({ result }) => {
    const json = extractTokenJson(result);
    if (!json) {
      return {
        ok: false,
        findings: [
          {
            kind: 'PARSE',
            message:
              'no DTCG token JSON found in the produced output — return the token file as JSON',
          },
        ],
      };
    }
    const tokenPath = `design-language/tokens/${tokenStem(capabilityType)}.tokens.json`;
    const viewPath = tokenPath.replace(/\.json$/, '.md');
    let view = '';
    try {
      view = renderTokenView(JSON.parse(json));
    } catch {
      // json parsed in extractTokenJson, so this is unreachable in practice;
      // an empty view just means VIEW_DRIFT, a legible finding, not a throw.
    }
    const verdict = verifyFiles({ [tokenPath]: json, [viewPath]: view });
    return { ok: verdict.ok, findings: verdict.findings };
  };
}

/** Resolve a capability's declared `verify` name to a runnable Verifier, or null
 * when the MCP has no runner for it (the caller falls back to the practices
 * review). Today the MCP runs `design-pack` (the shared package is always
 * present); other named gates resolve to null until their runner lands. Async
 * for a stable interface across runners that may need to load. */
export async function resolveVerifier(
  name: string | undefined,
  capabilityType: string
): Promise<Verifier | null> {
  return name === 'design-pack' ? designPackVerifier(capabilityType) : null;
}
