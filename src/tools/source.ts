import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { grepSource, warmSource } from '@verevoir/context';
import { findSymbols } from '@verevoir/context/code';
import { pickSourceAdapter, resolveSourceEnv } from '../router.js';
import { applyEdit } from '../edit.js';

export function registerSourceTools(server: McpServer): void {
  // -------------------------------------------------------------------------
  // read_file
  // -------------------------------------------------------------------------
  server.registerTool(
    'read_file',
    {
      description:
        "Read a file's full contents from any source — a local repo (absolute path), a GitHub repo, or Notion. Prefer this over the built-in file Read for project/repo files: reads are cached per (sourceUrl, ref, path) and the cache is shared with grep/find_symbol, so reading also warms the index for later search. Returns { content, sha }.",
      inputSchema: {
        sourceUrl: z
          .string()
          .describe(
            'Source, auto-routed by form: local path (/abs/path or file://...), GitHub repo (https://github.com/owner/repo), or Notion (https://www.notion.so/<id>).'
          ),
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
        'List directory entries at a path prefix within a source (local path, GitHub repo, or Notion page tree). Use it to orient before reading; prefer over shell ls/find for project files. Returns DirEntry[] (name, type, path, sha).',
      inputSchema: {
        sourceUrl: z
          .string()
          .describe(
            'Source, auto-routed by form: local path (/abs/path or file://...), GitHub repo (https://github.com/owner/repo), or Notion (https://www.notion.so/<id>).'
          ),
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
        'Fetch the full file tree for a source (local path, GitHub repo, or Notion page tree) in one call — the fastest way to orient in an unfamiliar repo. May be large for big repos; use list_files for narrower scopes. Returns RepoTree with entries[] and a truncated flag.',
      inputSchema: {
        sourceUrl: z
          .string()
          .describe(
            'Source, auto-routed by form: local path (/abs/path or file://...), GitHub repo (https://github.com/owner/repo), or Notion (https://www.notion.so/<id>).'
          ),
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
        'Search file contents for a pattern across an entire source on demand. Scans the whole tree (skipping vendored / build dirs), pulling files into the shared cache as it goes — no need to read files first. Prefer over shell grep for project files. Returns GrepHit[] with line + context.',
      inputSchema: {
        sourceUrl: z
          .string()
          .describe(
            'Source, auto-routed by form: local path (/abs/path or file://...), GitHub repo (https://github.com/owner/repo), or Notion (https://www.notion.so/<id>).'
          ),
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
      const adapter = await pickSourceAdapter(sourceUrl);
      const env = resolveSourceEnv(sourceUrl);
      const result = await grepSource(adapter, env, sourceUrl, pattern, {
        ref,
        ignoreCase,
        maxResults,
      });
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
        'Find where a named function, class, method, interface, type, or enum is defined — scans the whole source on demand, tree-sitter-parsing files into the shared cache as it goes (no need to read files first). Prefer over guessing or shell-grepping for definitions. Returns SymbolHit[] with file path and line range.',
      inputSchema: {
        sourceUrl: z
          .string()
          .describe(
            'Source, auto-routed by form: local path (/abs/path or file://...), GitHub repo (https://github.com/owner/repo), or Notion (https://www.notion.so/<id>).'
          ),
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
      const adapter = await pickSourceAdapter(sourceUrl);
      const env = resolveSourceEnv(sourceUrl);
      await warmSource(adapter, env, sourceUrl, { ref });
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
        "Write a file's full contents to a source and populate the read cache with it. GitHub sources commit to the given branch via the contents API; filesystem sources write directly to disk with no git staging (branch + commitMessage ignored). Returns { ok: true }.",
      inputSchema: {
        sourceUrl: z
          .string()
          .describe(
            'Source, auto-routed by form: local path (/abs/path or file://...), GitHub repo (https://github.com/owner/repo), or Notion (https://www.notion.so/<id>).'
          ),
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

  // -------------------------------------------------------------------------
  // edit_file
  // -------------------------------------------------------------------------
  server.registerTool(
    'edit_file',
    {
      description:
        'Surgically edit a file in any source: replace an exact `oldString` with `newString`, then re-populate the read cache. Keeps the whole read->edit->write cycle inside this toolchain (no built-in Read/Edit needed), and works on local, GitHub, and Notion sources alike. `oldString` must match exactly once unless `replaceAll` is set — include enough surrounding context to make it unique. GitHub commits to `branch`; filesystem writes directly (branch + commitMessage ignored). Returns { ok: true, replacements }.',
      inputSchema: {
        sourceUrl: z
          .string()
          .describe(
            'Source, auto-routed by form: local path (/abs/path or file://...), GitHub repo (https://github.com/owner/repo), or Notion (https://www.notion.so/<id>).'
          ),
        path: z.string().describe('File path within the source.'),
        oldString: z
          .string()
          .describe('Exact text to replace. Must match exactly once unless replaceAll is true.'),
        newString: z.string().describe('Replacement text.'),
        branch: z
          .string()
          .describe('Branch to commit to (GitHub). Ignored for filesystem sources.'),
        commitMessage: z
          .string()
          .describe('Commit message (GitHub). Ignored for filesystem sources.'),
        replaceAll: z
          .boolean()
          .optional()
          .describe('Replace every occurrence instead of requiring a unique match. Default false.'),
      },
    },
    async ({ sourceUrl, path, oldString, newString, branch, commitMessage, replaceAll }) => {
      const adapter = await pickSourceAdapter(sourceUrl);
      const env = resolveSourceEnv(sourceUrl);
      const { content } = await adapter.readFile(env, sourceUrl, path, branch);
      const result = applyEdit(content, oldString, newString, replaceAll ?? false);
      await adapter.writeFile(env, sourceUrl, path, result.content, branch, commitMessage);
      return {
        content: [
          { type: 'text', text: JSON.stringify({ ok: true, replacements: result.replacements }) },
        ],
      };
    }
  );
}
