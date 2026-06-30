import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Verifier } from '@verevoir/recipes/engine';
import { pickSourceAdapter, resolveSourceEnv } from '../router.js';

// STDIO-507 / STDIO-510 — the MCP runs a capability's own declared gate.
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
//
// STDIO-510: the tooling is read through the SAME source adapter the corpus
// itself is read through (`@verevoir/sources` via router), so the gate fires
// whether the corpus is a local checkout OR a remote (github / notion) source —
// not just a local clone. The zero-dependency `.mjs` files are materialised to a
// temp dir and dynamically imported (their cross-file imports resolve as
// siblings there).

const DEFAULT_GUARDRAILS_URL = 'https://github.com/verevoir/aigency-guardrails';

function guardrailsUrl(): string {
  return process.env.AIGENCY_GUARDRAILS_URL?.trim() || DEFAULT_GUARDRAILS_URL;
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

const TOOLING_DIR = 'tooling/design';

/** Pick the runnable design-tooling modules from a directory listing: the
 * zero-dependency `.mjs` sources, excluding tests. Pure — the filtering rule in
 * one testable place. */
export function pickToolingFiles(entries: { type: string; name: string; path: string }[]): {
  name: string;
  path: string;
}[] {
  return entries
    .filter((e) => e.type === 'file' && e.name.endsWith('.mjs') && !e.name.endsWith('.test.mjs'))
    .map((e) => ({ name: e.name, path: e.path }));
}

/** Read the design tooling `.mjs` sources from the corpus via the source adapter
 * (local or remote), as a `{ filename → content }` map. Null when the corpus is
 * unreachable or holds no tooling. Never throws. The whole `tooling/design`
 * directory is read so the inter-file imports (`verify-pack` → `dtcg` /
 * `generate` / `gate` …) resolve once materialised as siblings. */
export async function fetchDesignToolingFiles(
  url: string = guardrailsUrl()
): Promise<Record<string, string> | null> {
  let adapter: Awaited<ReturnType<typeof pickSourceAdapter>>;
  let env: ReturnType<typeof resolveSourceEnv>;
  try {
    adapter = await pickSourceAdapter(url);
    env = resolveSourceEnv(url);
  } catch {
    return null;
  }
  let entries: { type: string; name: string; path: string }[];
  try {
    entries = (await adapter.listFiles(env, url, TOOLING_DIR)) as typeof entries;
  } catch {
    return null;
  }
  if (!Array.isArray(entries)) return null;
  const files: Record<string, string> = {};
  for (const f of pickToolingFiles(entries)) {
    try {
      const { content } = await adapter.readFile(env, url, f.path);
      files[f.name] = content;
    } catch {
      // skip an unreadable file — a missing dependency surfaces at import time
      // as a null tooling (honest "not runnable"), never a throw.
    }
  }
  return Object.keys(files).length > 0 ? files : null;
}

let toolingMemo: DesignTooling | null | undefined;

/** Test seam: drop the loaded-tooling memo. */
export function clearDesignToolingMemo(): void {
  toolingMemo = undefined;
}

/** Materialise a `{ filename → content }` tooling map to a fresh temp dir and
 * dynamically import `verify-pack.mjs` + `generate.mjs` from it. Null when the
 * map lacks them or the import fails. The temp dir persists for the process
 * (the imported modules reference it). */
async function importTooling(files: Record<string, string>): Promise<DesignTooling | null> {
  if (!files['verify-pack.mjs'] || !files['generate.mjs']) return null;
  try {
    const dir = mkdtempSync(join(tmpdir(), 'design-tooling-'));
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(dir, name), content);
    }
    const vp = (await import(pathToFileURL(join(dir, 'verify-pack.mjs')).href)) as {
      verifyFiles?: DesignTooling['verifyFiles'];
    };
    const gen = (await import(pathToFileURL(join(dir, 'generate.mjs')).href)) as {
      renderTokenView?: DesignTooling['renderTokenView'];
    };
    return typeof vp.verifyFiles === 'function' && typeof gen.renderTokenView === 'function'
      ? { verifyFiles: vp.verifyFiles, renderTokenView: gen.renderTokenView }
      : null;
  } catch {
    return null;
  }
}

/** Load the corpus's zero-dependency design tooling (`verifyFiles` +
 * `renderTokenView`), memoised for the process. Reads the tooling through the
 * source adapter (local OR remote) and dynamically imports it. Null when the
 * corpus is unreachable or the tooling can't be loaded — never throws, so a
 * missing gate degrades to "not runnable here" rather than crashing enact.
 * `fetch` is injected for tests. */
export async function loadDesignTooling(
  url: string = guardrailsUrl(),
  fetch: (u: string) => Promise<Record<string, string> | null> = fetchDesignToolingFiles
): Promise<DesignTooling | null> {
  if (toolingMemo !== undefined) return toolingMemo;
  const files = await fetch(url).catch(() => null);
  toolingMemo = files ? await importTooling(files) : null;
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
