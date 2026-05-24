import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { grep } from '@verevoir/context';
import { findSymbols } from '@verevoir/context/code';
import { pickSourceAdapter, resolveSourceEnv } from '../router.js';

export function registerSourceTools(server: McpServer): void {
  // -------------------------------------------------------------------------
  // read_file
  // -------------------------------------------------------------------------
  server.registerTool(
    'read_file',
    {
      description:
        'Read a file from a source URL via the Verevoir cached adapter. Reads are cached per (sourceUrl, ref, path) so subsequent calls return immediately from memory.',
      inputSchema: {
        sourceUrl: z
          .string()
          .describe('GitHub repo URL (https://github.com/owner/repo) or absolute filesystem path.'),
        path: z.string().describe('File path within the source.'),
        ref: z.string().optional().describe('Git ref / branch / sha. Omit for default branch.'),
      },
    },
    async ({ sourceUrl, path, ref }) => {
      const adapter = await pickSourceAdapter(sourceUrl);
      const env = resolveSourceEnv(sourceUrl);
      const result = await adapter.readFile(env, sourceUrl, path, ref);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  // -------------------------------------------------------------------------
  // list_files
  // -------------------------------------------------------------------------
  server.registerTool(
    'list_files',
    {
      description:
        'List directory entries at a path prefix within a source. Returns DirEntry[] (name, type, path, sha).',
      inputSchema: {
        sourceUrl: z
          .string()
          .describe('GitHub repo URL (https://github.com/owner/repo) or absolute filesystem path.'),
        prefix: z.string().optional().describe("Directory prefix to list. Defaults to root ('')."),
        ref: z.string().optional().describe('Git ref / branch / sha. Omit for default branch.'),
      },
    },
    async ({ sourceUrl, prefix, ref }) => {
      const adapter = await pickSourceAdapter(sourceUrl);
      const env = resolveSourceEnv(sourceUrl);
      const result = await adapter.listFiles(env, sourceUrl, prefix ?? '', ref);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  // -------------------------------------------------------------------------
  // get_repo_tree
  // -------------------------------------------------------------------------
  server.registerTool(
    'get_repo_tree',
    {
      description:
        'Fetch the full file tree for a source. May be large for big repos; use list_files for narrower scopes. Returns RepoTree with entries[] and a truncated flag.',
      inputSchema: {
        sourceUrl: z
          .string()
          .describe('GitHub repo URL (https://github.com/owner/repo) or absolute filesystem path.'),
        ref: z.string().optional().describe('Git ref / branch / sha. Omit for default branch.'),
      },
    },
    async ({ sourceUrl, ref }) => {
      const adapter = await pickSourceAdapter(sourceUrl);
      const env = resolveSourceEnv(sourceUrl);
      const result = await adapter.getRepoTree(env, sourceUrl, ref);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  // -------------------------------------------------------------------------
  // grep
  // -------------------------------------------------------------------------
  server.registerTool(
    'grep',
    {
      description:
        'Search cached content for a pattern. Operates ONLY over files already in the in-process cache — call read_file first on any files you want searchable. Returns GrepHit[] with line + context.',
      inputSchema: {
        sourceUrl: z
          .string()
          .describe('GitHub repo URL (https://github.com/owner/repo) or absolute filesystem path.'),
        pattern: z.string().describe('Plain-text substring to search for.'),
        ref: z
          .string()
          .optional()
          .describe(
            'Git ref / branch / sha that scopes the cache lookup. Omit for default branch.'
          ),
        ignoreCase: z.boolean().optional().describe('Case-insensitive match. Defaults to false.'),
        maxResults: z.number().optional().describe('Maximum hits to return. Defaults to 50.'),
      },
    },
    async ({ sourceUrl, pattern, ref, ignoreCase, maxResults }) => {
      const result = grep(
        pattern,
        {
          sources: [{ sourceId: sourceUrl, version: ref ?? '' }],
        },
        { ignoreCase, maxResults }
      );
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  // -------------------------------------------------------------------------
  // find_symbol
  // -------------------------------------------------------------------------
  server.registerTool(
    'find_symbol',
    {
      description:
        'Search the symbol index for a named function, class, method, interface, type, or enum. Operates on cached + parsed content only — read_file first. Returns SymbolHit[] with file path and line range.',
      inputSchema: {
        sourceUrl: z
          .string()
          .describe('GitHub repo URL (https://github.com/owner/repo) or absolute filesystem path.'),
        name: z.string().describe('Symbol name to search (substring match, case-insensitive).'),
        ref: z
          .string()
          .optional()
          .describe(
            'Git ref / branch / sha that scopes the cache lookup. Omit for default branch.'
          ),
        kind: z
          .enum(['function', 'class', 'method', 'interface', 'type', 'enum'])
          .optional()
          .describe('Restrict results to a specific symbol kind.'),
      },
    },
    async ({ sourceUrl, name, ref, kind }) => {
      const hits = findSymbols(name, {
        sources: [{ sourceId: sourceUrl, version: ref ?? '' }],
      });
      const filtered = kind ? hits.filter((h) => h.kind === kind) : hits;
      return {
        content: [{ type: 'text', text: JSON.stringify(filtered) }],
      };
    }
  );

  // -------------------------------------------------------------------------
  // write_file
  // -------------------------------------------------------------------------
  server.registerTool(
    'write_file',
    {
      description:
        'Write content to a file. For GitHub sources, commits to the specified branch via the contents API. For filesystem sources, writes to disk (branch and commitMessage are ignored).',
      inputSchema: {
        sourceUrl: z
          .string()
          .describe('GitHub repo URL (https://github.com/owner/repo) or absolute filesystem path.'),
        path: z.string().describe('File path within the source.'),
        content: z.string().describe('Full file content to write.'),
        branch: z
          .string()
          .describe('Branch to commit to (GitHub). Ignored for filesystem sources.'),
        commitMessage: z
          .string()
          .describe('Commit message (GitHub). Ignored for filesystem sources.'),
      },
    },
    async ({ sourceUrl, path, content, branch, commitMessage }) => {
      const adapter = await pickSourceAdapter(sourceUrl);
      const env = resolveSourceEnv(sourceUrl);
      await adapter.writeFile(env, sourceUrl, path, content, branch, commitMessage);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };
    }
  );
}
