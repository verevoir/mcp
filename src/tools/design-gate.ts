import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import type { Verifier } from '@verevoir/recipes/engine';

// STDIO-507 — the MCP runs a capability's own declared gate.
//
// `enact_capability` produces a gated capability on the worker tier, but a
// produce that is only practices-reviewed doesn't ENFORCE the deterministic
// check the capability declared (e.g. `design-pack`). A capability addressed as
// a tool has to carry its own verification — a tool validates its output, it
// doesn't leave that to the caller. This module gives the MCP access to the
// corpus's OWN gate tooling and exposes it as a Verifier, so the declared check
// runs as a hard postcondition and the worker is looped on its findings. It runs
// the one zero-dependency source in the corpus, not a second copy — the same
// gate aigency-web runs.

const DEFAULT_GUARDRAILS_URL = 'https://github.com/verevoir/aigency-guardrails';

function guardrailsUrl(): string {
  return process.env.AIGENCY_GUARDRAILS_URL?.trim() || DEFAULT_GUARDRAILS_URL;
}

/** Resolve the guardrails corpus to a local directory that holds the design
 * tooling, or null when it isn't a local checkout (a remote source — fetching
 * its tooling to a temp dir is a follow-up; the caller falls back to the
 * practices review). Never throws. */
export function localDesignToolingDir(url: string = guardrailsUrl()): string | null {
  let p = url.trim();
  if (!p) return null;
  if (p.startsWith('file://')) {
    try {
      p = fileURLToPath(p);
    } catch {
      return null;
    }
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p) || p.includes('github.com')) {
    return null; // a remote source — not on disk
  }
  const dir = resolve(p);
  return existsSync(join(dir, 'tooling', 'design', 'verify-pack.mjs')) ? dir : null;
}

/** The slice of the corpus's design tooling enact needs: the pure in-memory
 * verifier and the view renderer. Both are zero-dependency Node built-ins. */
export interface DesignTooling {
  verifyFiles: (files: Record<string, string>) => {
    ok: boolean;
    findings: { kind: string; file?: string; where?: string; message: string }[];
  };
  renderTokenView: (tokens: unknown) => string;
}

let toolingMemo: DesignTooling | null | undefined;

/** Test seam: drop the loaded-tooling memo. */
export function clearDesignToolingMemo(): void {
  toolingMemo = undefined;
}

/** Dynamically load the corpus's zero-dependency design tooling (`verifyFiles` +
 * `renderTokenView`), memoised for the process. Null when the corpus isn't a
 * local checkout or the tooling can't be loaded — never throws, so a missing
 * gate degrades to "not runnable here" rather than crashing enact. */
export async function loadDesignTooling(
  url: string = guardrailsUrl()
): Promise<DesignTooling | null> {
  if (toolingMemo !== undefined) return toolingMemo;
  const dir = localDesignToolingDir(url);
  if (!dir) {
    toolingMemo = null;
    return null;
  }
  try {
    const vp = (await import(
      pathToFileURL(join(dir, 'tooling', 'design', 'verify-pack.mjs')).href
    )) as { verifyFiles?: DesignTooling['verifyFiles'] };
    const gen = (await import(
      pathToFileURL(join(dir, 'tooling', 'design', 'generate.mjs')).href
    )) as { renderTokenView?: DesignTooling['renderTokenView'] };
    toolingMemo =
      typeof vp.verifyFiles === 'function' && typeof gen.renderTokenView === 'function'
        ? { verifyFiles: vp.verifyFiles, renderTokenView: gen.renderTokenView }
        : null;
  } catch {
    toolingMemo = null;
  }
  return toolingMemo;
}

/** Pull the DTCG token JSON out of a worker's produced text — it may wrap the
 * file in a ```json fence or surround it with prose. Returns the first chunk
 * that parses as JSON, else null. */
export function extractTokenJson(text: string): string | null {
  const candidates: string[] = [];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidates.push(fence[1].trim());
  const start = text.indexOf('{');
  if (start >= 0) {
    let depth = 0;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          candidates.push(text.slice(start, i + 1));
          break;
        }
      }
    }
  }
  for (const c of candidates) {
    try {
      JSON.parse(c);
      return c;
    } catch {
      // try the next candidate
    }
  }
  return null;
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
 * in-memory pack (the token file + its generated view) and run the corpus's
 * `verifyFiles` over it — returning the gate's verdict as a VerifyResult that
 * plugs straight into the produce→verify loop. The generated view is rendered
 * here (it isn't the worker's job to produce it), so VIEW_DRIFT can't fire on a
 * generation step; the gate's force is DTCG validity + value-drift. */
export function designPackVerifier(tooling: DesignTooling, capabilityType: string): Verifier {
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
      view = tooling.renderTokenView(JSON.parse(json));
    } catch {
      // json parsed in extractTokenJson, so this is unreachable in practice;
      // an empty view just means VIEW_DRIFT, a legible finding, not a throw.
    }
    const verdict = tooling.verifyFiles({ [tokenPath]: json, [viewPath]: view });
    return { ok: verdict.ok, findings: verdict.findings };
  };
}

/** Resolve a capability's declared `verify` name to a runnable Verifier, or null
 * when the MCP has no runner for it (the caller falls back to the practices
 * review). Today the MCP runs `design-pack`; other named gates resolve to null
 * until their runner lands. */
export async function resolveVerifier(
  name: string | undefined,
  capabilityType: string,
  url: string = guardrailsUrl()
): Promise<Verifier | null> {
  if (name !== 'design-pack') return null;
  const tooling = await loadDesignTooling(url);
  return tooling ? designPackVerifier(tooling, capabilityType) : null;
}
