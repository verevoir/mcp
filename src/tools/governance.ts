import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { isAbsolute, dirname, resolve as resolvePath } from 'node:path';
import { wrapWithCache } from '@verevoir/context';
import { pickSourceAdapter, resolveSourceEnv } from '../router.js';
import { loadManifest, manifestPath, type AigencyManifest } from '../manifest.js';

// Surface the project's governance — its ADRs and living model docs, the named
// key pages, AND the framework governance that lives in the corpus repo (the
// ADRs / principles / glossary and the *practices*) — as one low-effort,
// scannable index. Governance comes from more than one source the same way
// code does (filesystem or GitHub): the Notion project record and the
// guardrails corpus are indexed *together*, every entry read back the same way
// via read_file. The point (per the capability model's "found one way" +
// "lower the floor"): a small model finds the right decision/standard by
// reading one-liners, not by knowing which store to grep.

function notionUrl(id: string): string {
  return `https://www.notion.so/${id.replace(/-/g, '')}`;
}

export interface GovernanceEntry {
  title: string;
  /** sourceUrl to pass to read_file. */
  source: string;
  /** path within the source (empty for a whole page). */
  path: string;
  /** display hint read off where it sits — 'ADR', 'practice', 'principle'. */
  kind?: string;
}

/** Humanise a `.md` file within a governance source into a scannable entry.
 * Title is the filename stem (a README is titled by its folder so the index
 * doesn't fill with bare "readme"s); kind is read off the path so the scanner
 * can tell an ADR from a practice. */
function entryFromFile(source: string, path: string): GovernanceEntry {
  const segments = path.split('/').filter(Boolean);
  const file = segments[segments.length - 1] ?? path;
  const parent = segments[segments.length - 2];
  const stem = file.replace(/\.md$/i, '');
  const kind = path.includes('/adr')
    ? 'ADR'
    : /practice/i.test(path)
      ? 'practice'
      : /principle/i.test(path)
        ? 'principle'
        : undefined;
  const title =
    stem.toLowerCase() === 'readme' && parent
      ? `${parent.replace(/[-_]/g, ' ')} — overview`
      : stem.replace(/[-_]/g, ' ');
  return { title, source, path, kind };
}

/** Index one governance source's declared paths. A path ending in `.md` is a
 * single file; otherwise it's a directory whose `.md` files are listed. An
 * unreadable source or path is skipped (no token / source down) so the rest of
 * the index still builds. */
async function indexGovernanceSource(source: string, paths: string[]): Promise<GovernanceEntry[]> {
  const out: GovernanceEntry[] = [];
  let adapter: Awaited<ReturnType<typeof pickSourceAdapter>>;
  let env: ReturnType<typeof resolveSourceEnv>;
  try {
    adapter = wrapWithCache(await pickSourceAdapter(source));
    env = resolveSourceEnv(source);
  } catch {
    return out; // source unreadable — skip the whole source
  }
  for (const p of paths) {
    try {
      if (/\.md$/i.test(p)) {
        out.push(entryFromFile(source, p));
        continue;
      }
      const files = await adapter.listFiles(env, source, p);
      if (Array.isArray(files)) {
        for (const f of files) {
          if (f.type === 'file' && /\.md$/i.test(f.name)) {
            out.push(entryFromFile(source, f.path));
          }
        }
      }
    } catch {
      // unreadable path — skip it, keep going.
    }
  }
  return out;
}

/** Resolve a governance source to a form the adapter accepts. A URL (github /
 * notion / file://) or an absolute path passes through unchanged; a bare
 * relative path is resolved against the manifest's own directory — so a
 * committed manifest can point at a sibling clone ("projects/aigency-guardrails")
 * portably, with no hard-coded machine path, and the router (which rejects bare
 * relative paths) is handed an absolute one. */
export function resolveGovernanceSource(source: string, manifestDir: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source) || isAbsolute(source)) {
    return source;
  }
  return resolvePath(manifestDir, source);
}

/** Build the governance index across every source: the Notion project record
 * (ADRs database + named key pages) and each declared governance source (the
 * guardrails corpus — ADRs, principles, glossary, practices). Returns [] when
 * there's no manifest; an unreadable source is skipped, never fatal. */
export async function loadGovernanceIndex(
  manifest: AigencyManifest | null = loadManifest()
): Promise<GovernanceEntry[]> {
  if (!manifest) return [];
  const entries: GovernanceEntry[] = [];
  const notion = manifest.notion;

  // Source 1 — the Notion project record: the ADRs database (its cards, incl.
  // the living model docs filed there) plus the named key pages.
  if (notion) {
    const adrsId = notion.databases?.adrs;
    if (adrsId) {
      const sourceUrl = notionUrl(adrsId);
      try {
        const adapter = wrapWithCache(await pickSourceAdapter(sourceUrl));
        const env = resolveSourceEnv(sourceUrl);
        const cards = await adapter.listFiles(env, sourceUrl, '');
        if (Array.isArray(cards)) {
          for (const card of cards) {
            entries.push({
              title: card.name,
              source: sourceUrl,
              path: card.path,
              kind: 'ADR',
            });
          }
        }
      } catch {
        // unreadable (no token / source down) — skip ADRs, keep the pages.
      }
    }
    for (const [name, id] of Object.entries(notion.pages ?? {})) {
      entries.push({
        title: name.replace(/_/g, ' '),
        source: notionUrl(id),
        path: '',
      });
    }
  }

  // Source 2+ — declared governance sources (the guardrails corpus), indexed
  // together with the record so the framework's ADRs and practices are found
  // by the same scan. A relative source resolves against the manifest's own
  // directory, so the committed manifest can point at a sibling clone.
  const manifestDir = dirname(manifestPath());
  for (const gov of manifest.governance ?? []) {
    const source = resolveGovernanceSource(gov.source, manifestDir);
    entries.push(...(await indexGovernanceSource(source, gov.paths)));
  }

  return entries;
}

/** Narrow the index by an intent query — tokenised, matched across each
 * entry's title / kind / path, ranked by how many tokens hit. So "capability",
 * "capability model" and "capability practice model standard" all surface the
 * model, rather than failing a whole-string substring on the title alone. */
export function filterGovernance(
  index: GovernanceEntry[],
  query: string | undefined
): GovernanceEntry[] {
  const q = query?.trim().toLowerCase();
  if (!q) return index;
  const tokens = q.split(/\s+/).filter(Boolean);
  return index
    .map((e) => {
      const hay = `${e.title} ${e.kind ?? ''} ${e.path}`.toLowerCase();
      return { e, score: tokens.filter((t) => hay.includes(t)).length };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.e.title.localeCompare(b.e.title))
    .map((s) => s.e);
}

function renderIndex(
  hits: GovernanceEntry[],
  index: GovernanceEntry[],
  query: string | undefined
): string {
  if (hits.length === 0) {
    return index.length === 0
      ? 'No governance configured (no project manifest, or the record is unreadable).'
      : `No governance matching "${query}". ${index.length} entries exist — broaden the query or omit it.`;
  }
  const lines = hits.map(
    (e) =>
      `- ${e.title}${e.kind ? ` (${e.kind})` : ''}\n  read_file(sourceUrl: "${e.source}"${e.path ? `, path: "${e.path}"` : ''})`
  );
  const header = `${hits.length} governance entr${hits.length === 1 ? 'y' : 'ies'}${query ? ` matching "${query}"` : ''} — scan, then read the one you need:`;
  return `${header}\n\n${lines.join('\n')}`;
}

/** Register `find_governance`: a scannable, narrowable index of the project's
 * decisions and standards across every governance source, so any model (down
 * to a small one) can locate the right one and read it, instead of being told
 * where to look. */
export function registerGovernanceTool(server: McpServer): void {
  server.registerTool(
    'find_governance',
    {
      description:
        "Find the project's governing decisions and standards — ADRs, principles, the glossary, and the practices (the quality standards and how we judge code meets them) — across every governance source (the Notion project record and the corpus repo), as one compact, scannable index. Title + how to read each with read_file, so you select the relevant one rather than loading the whole set. Omit `query` for the full index; pass an intent to narrow (e.g. 'capability', 'practice', 'addressability', 'deploy').",
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe(
            "Intent to narrow by — tokenised and matched across each entry's title, kind and path, ranked by hits. Omit for the full index."
          ),
      },
    },
    async ({ query }) => {
      const index = await loadGovernanceIndex();
      const hits = filterGovernance(index, query);
      return {
        content: [{ type: 'text' as const, text: renderIndex(hits, index, query) }],
      };
    }
  );
}
