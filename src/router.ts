import type { SourceAdapter } from '@verevoir/sources';
import type { WorkflowAdapter, WorkflowEnv } from '@verevoir/workflows';
import { envFromProcessEnv } from '@verevoir/sources';
import { envFromTrelloProcessEnv } from '@verevoir/workflows/trello';

// ---------------------------------------------------------------------------
// Source adapter routing
// ---------------------------------------------------------------------------

type SourceKind = 'github' | 'fs';

function classifySourceUrl(sourceUrl: string): SourceKind {
  if (sourceUrl.startsWith('https://github.com/')) return 'github';
  if (
    sourceUrl.startsWith('/') ||
    sourceUrl.startsWith('~/') ||
    sourceUrl.startsWith('./') ||
    sourceUrl.startsWith('file://')
  )
    return 'fs';
  throw new Error(
    `Unsupported source URL: ${sourceUrl}. Expected github.com URL or absolute filesystem path.`
  );
}

/** Dynamically import and return the cached SourceAdapter for the given URL. */
export async function pickSourceAdapter(sourceUrl: string): Promise<SourceAdapter> {
  const kind = classifySourceUrl(sourceUrl);
  if (kind === 'github') {
    const { github } = await import('@verevoir/context/github');
    return github;
  }
  const { fs } = await import('@verevoir/context/fs');
  return fs;
}

/** Resolve the SourceEnv appropriate for the given URL.
 * GitHub sources require GITHUB_TOKEN; filesystem sources need no token. */
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
  // Filesystem adapter ignores token + forkOrg.
  return { token: '', forkOrg: '' };
}

// ---------------------------------------------------------------------------
// Workflow adapter routing
// ---------------------------------------------------------------------------

/** Dynamically import and return the WorkflowAdapter for the given board URL. */
export async function pickWorkflowAdapter(boardUrl: string): Promise<WorkflowAdapter> {
  if (/^https:\/\/trello\.com\/b\/[^/]+/.test(boardUrl)) {
    const { trello } = await import('@verevoir/workflows/trello');
    return trello;
  }
  // Future: Jira, Linear, Notion adapters would slot in here.
  throw new Error(`Unsupported board URL: ${boardUrl}. Expected https://trello.com/b/<id>.`);
}

/** Build WorkflowEnv for the given board URL.
 * Trello requires TRELLO_API_KEY, TRELLO_API_TOKEN, and TRELLO_REFERER. */
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
  throw new Error(`Unsupported board URL: ${boardUrl}. Expected https://trello.com/b/<id>.`);
}
