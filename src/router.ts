import type { SourceAdapter } from '@verevoir/sources';
import type { WorkflowAdapter, WorkflowEnv } from '@verevoir/workflows';
import { envFromProcessEnv } from '@verevoir/sources';
import { envFromTrelloProcessEnv } from '@verevoir/workflows/trello';
import { envFromNotionProcessEnv } from '@verevoir/workflows/notion';
import { wrapWorkflowWithCache } from '@verevoir/context';

// ---------------------------------------------------------------------------
// Source adapter routing
// ---------------------------------------------------------------------------

type SourceKind = 'github' | 'fs' | 'notion';

function classifySourceUrl(sourceUrl: string): SourceKind {
  if (sourceUrl.startsWith('https://github.com/')) return 'github';
  if (/^https?:\/\/(www\.)?notion\.so\//.test(sourceUrl)) return 'notion';
  if (
    sourceUrl.startsWith('/') ||
    sourceUrl.startsWith('~/') ||
    sourceUrl.startsWith('./') ||
    sourceUrl.startsWith('file://')
  )
    return 'fs';
  throw new Error(
    `Unsupported source URL: ${sourceUrl}. Expected github.com URL, notion.so URL, or absolute filesystem path.`
  );
}

/** Dynamically import and return the cached SourceAdapter for the given URL. */
export async function pickSourceAdapter(sourceUrl: string): Promise<SourceAdapter> {
  const kind = classifySourceUrl(sourceUrl);
  if (kind === 'github') {
    const { github } = await import('@verevoir/context/github');
    return github;
  }
  if (kind === 'notion') {
    const { notion } = await import('@verevoir/context/notion');
    return notion;
  }
  const { fs } = await import('@verevoir/context/fs');
  return fs;
}

/** Resolve the SourceEnv appropriate for the given URL. GitHub
 * sources require `GITHUB_TOKEN`; Notion sources require
 * `NOTION_API_KEY`; filesystem sources need no token. */
export function resolveSourceEnv(sourceUrl: string): {
  token: string;
  forkOrg: string;
} {
  const kind = classifySourceUrl(sourceUrl);
  if (kind === 'github') {
    const env = envFromProcessEnv();
    if (!env) throw Object.assign(new Error('GITHUB_TOKEN not set'), { status: 401 });
    return env;
  }
  if (kind === 'notion') {
    const token = process.env.NOTION_API_KEY;
    if (!token) throw Object.assign(new Error('NOTION_API_KEY not set'), { status: 401 });
    return { token, forkOrg: '' };
  }
  // Filesystem adapter ignores token + forkOrg.
  return { token: '', forkOrg: '' };
}

// ---------------------------------------------------------------------------
// Workflow adapter routing
// ---------------------------------------------------------------------------

/** Dynamically import and return the **cached** WorkflowAdapter for the given
 * board URL. `wrapWorkflowWithCache` (default ~10s TTL, shared in-process
 * store) gives the list/get reads read-through caching with cheap
 * `isCardFresh` revalidation — the workflow twin of the cached source
 * subpaths. Collapses correlated re-reads within a process; writes pass
 * through and invalidate. */
export async function pickWorkflowAdapter(boardUrl: string): Promise<WorkflowAdapter> {
  if (/^https:\/\/trello\.com\/b\/[^/]+/.test(boardUrl)) {
    const { trello } = await import('@verevoir/workflows/trello');
    return wrapWorkflowWithCache(trello);
  }
  if (/^https?:\/\/(www\.)?notion\.so\//.test(boardUrl)) {
    const { notion } = await import('@verevoir/workflows/notion');
    return wrapWorkflowWithCache(notion);
  }
  // Future: Jira, Linear adapters would slot in here.
  throw new Error(
    `Unsupported board URL: ${boardUrl}. Expected https://trello.com/b/<id> or https://www.notion.so/<db-id>.`
  );
}

/** Build WorkflowEnv for the given board URL. Trello requires
 * `TRELLO_API_KEY` + `TRELLO_API_TOKEN` + `TRELLO_REFERER`; Notion
 * requires `NOTION_API_KEY`. */
export function resolveWorkflowEnv(boardUrl: string): WorkflowEnv {
  if (/^https:\/\/trello\.com\/b\/[^/]+/.test(boardUrl)) {
    const env = envFromTrelloProcessEnv();
    if (!env) {
      const missing = !process.env.TRELLO_API_KEY
        ? 'TRELLO_API_KEY'
        : !process.env.TRELLO_API_TOKEN
          ? 'TRELLO_API_TOKEN'
          : 'TRELLO_API_KEY or TRELLO_API_TOKEN';
      throw new Error(`${missing} not set — required for Trello boards.`);
    }
    if (!env.referer && !process.env.TRELLO_REFERER) {
      throw new Error('TRELLO_REFERER not set — required for Trello Power-Up origin matching.');
    }
    return env;
  }
  if (/^https?:\/\/(www\.)?notion\.so\//.test(boardUrl)) {
    const env = envFromNotionProcessEnv();
    if (!env) throw new Error('NOTION_API_KEY not set — required for Notion databases.');
    return env;
  }
  throw new Error(
    `Unsupported board URL: ${boardUrl}. Expected https://trello.com/b/<id> or https://www.notion.so/<db-id>.`
  );
}
