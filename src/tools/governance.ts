import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { wrapWithCache } from '@verevoir/context';
import { pickSourceAdapter, resolveSourceEnv } from '../router.js';
import { loadManifest, type AigencyManifest } from '../manifest.js';

// Surface the project's governance — its ADRs and the living model docs filed
// alongside them, plus the named key pages — as a low-effort, scannable index.
// The point (per the capability model's "found one way" + "lower the floor"):
// a small model should find the right decision by reading one-liners, not by
// knowing to grep Notion. The host calls find_governance, scans titles, and
// reads the one it needs with read_file. Select the slice, never load the set.

function notionUrl(id: string): string {
  return `https://www.notion.so/${id.replace(/-/g, '')}`;
}

export interface GovernanceEntry {
  title: string;
  /** sourceUrl to pass to read_file. */
  source: string;
  /** path within the source (empty for a whole page). */
  path: string;
}

/** Build the governance index from the manifest: the ADRs database (its cards,
 * including the living model docs filed there) plus the named key pages. Each
 * entry carries what read_file needs. Returns [] when there's no manifest; an
 * unreadable ADRs source is skipped (pages still index, no fetch needed). */
export async function loadGovernanceIndex(
  manifest: AigencyManifest | null = loadManifest(),
): Promise<GovernanceEntry[]> {
  const notion = manifest?.notion;
  if (!notion) return [];
  const entries: GovernanceEntry[] = [];

  // ADRs database — the decisions and the living model docs filed alongside.
  const adrsId = notion.databases?.adrs;
  if (adrsId) {
    const sourceUrl = notionUrl(adrsId);
    try {
      const adapter = wrapWithCache(await pickSourceAdapter(sourceUrl));
      const env = resolveSourceEnv(sourceUrl);
      const cards = await adapter.listFiles(env, sourceUrl, '');
      if (Array.isArray(cards)) {
        for (const card of cards) {
          entries.push({ title: card.name, source: sourceUrl, path: card.path });
        }
      }
    } catch {
      // unreadable (no token / source down) — skip the ADRs, keep the pages.
    }
  }

  // Named key pages from the manifest (glossary, start-here, …) — cheap
  // pointers; no fetch needed to index them.
  for (const [name, id] of Object.entries(notion.pages ?? {})) {
    entries.push({ title: name.replace(/_/g, ' '), source: notionUrl(id), path: '' });
  }

  return entries;
}

/** Filter the index by an intent query (case-insensitive substring on title). */
export function filterGovernance(
  index: GovernanceEntry[],
  query: string | undefined,
): GovernanceEntry[] {
  const q = query?.trim().toLowerCase();
  if (!q) return index;
  return index.filter((e) => e.title.toLowerCase().includes(q));
}

function renderIndex(
  hits: GovernanceEntry[],
  index: GovernanceEntry[],
  query: string | undefined,
): string {
  if (hits.length === 0) {
    return index.length === 0
      ? 'No governance configured (no project manifest, or the record is unreadable).'
      : `No governance matching "${query}". ${index.length} entries exist — broaden the query or omit it.`;
  }
  const lines = hits.map(
    (e) =>
      `- ${e.title}\n  read_file(sourceUrl: "${e.source}"${e.path ? `, path: "${e.path}"` : ''})`,
  );
  const header = `${hits.length} governance entr${hits.length === 1 ? 'y' : 'ies'}${query ? ` matching "${query}"` : ''} — scan, then read the one you need:`;
  return `${header}\n\n${lines.join('\n')}`;
}

/** Register `find_governance`: a scannable, narrowable index of the project's
 * ADRs + key docs, so any model (down to a small one) can locate the right
 * decision and read it, instead of being told where to look. */
export function registerGovernanceTool(server: McpServer): void {
  server.registerTool(
    'find_governance',
    {
      description:
        "Find the project's governing decisions (ADRs) and key reference docs by intent. Returns a compact, scannable index — title + how to read each with read_file — so you select the relevant one rather than loading the whole set. Omit `query` for the full index; pass an intent to narrow (e.g. 'capability model', 'state', 'deploy', 'idempotency').",
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe(
            'Intent to narrow by (case-insensitive substring on titles). Omit for the full index.',
          ),
      },
    },
    async ({ query }) => {
      const index = await loadGovernanceIndex();
      const hits = filterGovernance(index, query);
      return {
        content: [{ type: 'text' as const, text: renderIndex(hits, index, query) }],
      };
    },
  );
}
