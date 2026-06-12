import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { FOUNDATIONAL, provisionPractices } from '@verevoir/recipes/engine';
import { pickSourceAdapter, resolveSourceEnv } from '../router.js';

// PROVISION — "consult the bar before you write code", as one hop (STDIO-326).
//
// The diagnostic behind this card: a floor model coding through the MCP never
// consulted governance. That's not a visibility failure — `find_governance`
// sits right there — it's that a weak model won't run a multi-call scavenger
// hunt (find the index → read each file) unprompted, and nothing on the
// PRD→code path told it to. The fix is to make consultation a single, triggered
// step that returns the applicable practices' TEXT, not an index to chase.
//
// It also covers the case Claude Code's prompt lifecycle can't: a floor worker
// SUB-AGENT. You can't trigger a worker (it won't pull, and there's no hook into
// a spawned agent's frame) — you HAND it a frame. The coordinator calls
// `provision` for the work and bakes the returned practices into the worker's
// prompt, so the bar travels with the task.
//
// The practice axis only (v0): the FOUNDATIONAL floor always (no model call),
// plus concern-tagged practices when an ANTHROPIC_API_KEY is present (one
// reasoning call via @verevoir/recipes → @verevoir/llm). The capability axis
// (prose→capabilities via the embedding bin) is deliberately left out here — it
// pulls a heavy local embedder, a separate placement decision.

// The guardrails corpus practices are read from. Canonical by default; override
// for a fork or a per-project corpus (mirrors the skills loader).
const DEFAULT_GUARDRAILS_URL = 'https://github.com/verevoir/aigency-guardrails';

function guardrailsUrl(): string {
  return process.env.AIGENCY_GUARDRAILS_URL?.trim() || DEFAULT_GUARDRAILS_URL;
}

// New `corpus/` layout first, then the legacy flat layout (matches the skills
// loader's dual-path handling during the guardrails restructure).
const PRACTICES_DIRS = ['corpus/practices', 'practices'];

/** A provisioned practice with its full text. */
export interface LoadedPractice {
  id: string;
  body: string;
}

/** Resolve which corpus directory actually holds the practice `.md` files, by
 * listing each candidate and taking the first that lists files. Returns null
 * when the source is unreadable (e.g. no GITHUB_TOKEN) so the caller can degrade
 * to ids-only rather than fail. Adapter + env are returned so the caller reuses
 * them for the per-practice reads. */
async function resolvePracticesDir(sourceUrl: string): Promise<{
  adapter: Awaited<ReturnType<typeof pickSourceAdapter>>;
  env: ReturnType<typeof resolveSourceEnv>;
  dir: string;
} | null> {
  let adapter: Awaited<ReturnType<typeof pickSourceAdapter>>;
  let env: ReturnType<typeof resolveSourceEnv>;
  try {
    adapter = await pickSourceAdapter(sourceUrl);
    env = resolveSourceEnv(sourceUrl);
  } catch {
    return null;
  }
  for (const dir of PRACTICES_DIRS) {
    try {
      const entries = await adapter.listFiles(env, sourceUrl, dir);
      if (
        Array.isArray(entries) &&
        entries.some((e) => e.type === 'file' && e.name.endsWith('.md'))
      ) {
        return { adapter, env, dir };
      }
    } catch {
      // try the next candidate layout
    }
  }
  return null;
}

/** Load the full text of each practice id from the guardrails corpus. A
 * practice that can't be read is skipped (the frame still carries the ones it
 * found); an unreadable source yields []. Order follows `ids`. */
export async function loadPracticeBodies(
  ids: string[],
  sourceUrl: string = guardrailsUrl()
): Promise<LoadedPractice[]> {
  const resolved = await resolvePracticesDir(sourceUrl);
  if (!resolved) return [];
  const { adapter, env, dir } = resolved;
  const out: LoadedPractice[] = [];
  for (const id of ids) {
    try {
      const { content } = await adapter.readFile(env, sourceUrl, `${dir}/${id}.md`);
      out.push({ id, body: content.trim() });
    } catch {
      // unreadable practice — skip, it's reported as missing in the frame
    }
  }
  return out;
}

/** Render the provisioned frame: a short trigger line, then each practice's
 * full text. The bodies carry their own `#` headings, so they're joined with a
 * rule. Anything provisioned but unreadable is named so coverage gaps are
 * visible rather than silently dropped. */
export function renderFrame(loaded: LoadedPractice[], ids: string[], note: string): string {
  if (loaded.length === 0) {
    return (
      `Provisioned ${ids.length} practice${ids.length === 1 ? '' : 's'} (${note}), but none could be ` +
      `read from the guardrails corpus (${guardrailsUrl()}). Practice ids: ${ids.join(', ')}.`
    );
  }
  const header =
    `The practices your work is held to (${note}). Follow them — and if you hand this work to ` +
    `another model, pass this frame in its prompt: a floor worker won't fetch the bar itself.`;
  const blocks = loaded.map((p) => p.body).join('\n\n---\n\n');
  const missing = ids.filter((id) => !loaded.some((p) => p.id === id));
  const tail = missing.length > 0 ? `\n\n(Provisioned but unreadable: ${missing.join(', ')}.)` : '';
  return `${header}\n\n${blocks}${tail}`;
}

/** Provision the practice frame for a piece of work. FOUNDATIONAL floor always;
 * concern-tagged practices too when an ANTHROPIC_API_KEY is set (one reasoning
 * call). A failed tagging call degrades to the floor rather than erroring —
 * consultation is advisory and must never block the work. */
export async function provisionFrame(prose: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim() || null;
  let ids: string[];
  let note: string;
  if (apiKey) {
    try {
      ids = await provisionPractices({ prose }, apiKey);
      note = 'concern-tagged for this work';
    } catch (err) {
      ids = [...FOUNDATIONAL];
      note = `foundational floor only — concern-tagging failed (${String(err)})`;
    }
  } else {
    ids = [...FOUNDATIONAL];
    note = 'foundational floor only — set ANTHROPIC_API_KEY to add concern-specific practices';
  }
  const loaded = await loadPracticeBodies(ids);
  return renderFrame(loaded, ids, note);
}

/** Register the `provision` tool — the triggered, one-hop "consult the bar"
 * step that returns the practices a piece of work is held to, as text. */
export function registerProvisionTool(server: McpServer): void {
  server.registerTool(
    'provision',
    {
      description:
        "Before you implement or change code, call `provision` with a short description of the work you're about to do. It returns the **practices your output is held to** as text in one call — a foundational floor always, plus concern-specific practices tagged for this work — so you don't have to hunt the governance index. If you delegate the work to another (especially a cheaper) model, pass the returned frame in that worker's prompt: a floor worker won't fetch the bar itself, so the practices must travel with the task.",
      inputSchema: {
        prose: z
          .string()
          .describe(
            'A short prose description of the work about to be done — what gets classified to its applicable practices.'
          ),
      },
    },
    async ({ prose }) => ({
      content: [{ type: 'text' as const, text: await provisionFrame(prose) }],
    })
  );
}
