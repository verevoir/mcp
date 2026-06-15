import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { parseCapability, type CapabilityDescriptor } from '@verevoir/recipes';
import { FOUNDATIONAL, provisionPractices, buildCapabilityIndex } from '@verevoir/recipes/engine';
import type { ChatOptions, ChatReply } from '@verevoir/llm';
import { pickSourceAdapter, resolveSourceEnv } from '../router.js';
import { fetchEmbedder } from '../embedder.js';

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

// ── Capability axis (STDIO-339) ─────────────────────────────────────────────
// Surface the pre-built procedures (capabilities) that may fit the work, from
// the embedding bin. Advisory + generous: the top matches, the model picks.
// EMBEDDING-ONLY — no reasoning / narrowing call here, so it's provider-agnostic
// on the reasoning front; it needs only the (configurable, OpenAI-compatible)
// embeddings endpoint. Omitted entirely when no embeddings key is configured.

const CAPABILITIES_DIRS = ['corpus/capabilities', 'capabilities'];

// The bin is high-recall; for an advisory surface a tight set reads better than
// the full DEFAULT_K.
const CAPABILITY_SURFACE_K = 8;

/** A capability surfaced in the frame. */
export interface SurfacedCapability {
  type: string;
  summary: string;
}

let corpusMemo: CapabilityDescriptor[] | null = null;

/** Test seam: drop the in-process capability corpus memo. */
export function clearCapabilityCorpusMemo(): void {
  corpusMemo = null;
}

/** Recursively load + parse capability descriptors under a corpus dir. A
 * malformed descriptor is skipped; subfolders (e.g. `provisioning/`) are walked
 * so grouping doesn't affect loading. */
async function loadCapabilityDir(
  adapter: Awaited<ReturnType<typeof pickSourceAdapter>>,
  env: ReturnType<typeof resolveSourceEnv>,
  sourceUrl: string,
  dir: string
): Promise<CapabilityDescriptor[]> {
  let entries;
  try {
    entries = await adapter.listFiles(env, sourceUrl, dir);
  } catch {
    return [];
  }
  if (!Array.isArray(entries)) return [];
  const out: CapabilityDescriptor[] = [];
  for (const e of entries) {
    if (e.type === 'file' && e.name.endsWith('.md')) {
      const idHint = e.name.replace(/\.md$/, '');
      try {
        const { content } = await adapter.readFile(env, sourceUrl, e.path);
        out.push(parseCapability(idHint, content));
      } catch {
        // skip a malformed / unreadable descriptor — one bad capability
        // shouldn't disarm the rest.
      }
    } else if (e.type === 'dir') {
      out.push(...(await loadCapabilityDir(adapter, env, sourceUrl, e.path)));
    }
  }
  return out;
}

/** Load the capability corpus from the guardrails source (memoised for the
 * process). Tries the `corpus/` layout then legacy; `[]` when unreadable. */
export async function loadCapabilityCorpus(
  sourceUrl: string = guardrailsUrl()
): Promise<CapabilityDescriptor[]> {
  if (corpusMemo) return corpusMemo;
  let adapter: Awaited<ReturnType<typeof pickSourceAdapter>>;
  let env: ReturnType<typeof resolveSourceEnv>;
  try {
    adapter = await pickSourceAdapter(sourceUrl);
    env = resolveSourceEnv(sourceUrl);
  } catch {
    return [];
  }
  for (const dir of CAPABILITIES_DIRS) {
    const caps = await loadCapabilityDir(adapter, env, sourceUrl, dir);
    if (caps.length > 0) {
      corpusMemo = caps;
      return caps;
    }
  }
  return [];
}

/** Retrieve the capabilities that may fit the work via the embedding bin, or
 * `null` when no embeddings endpoint is configured (capability surfacing is
 * then simply omitted — practices still return). `[]` when the corpus is
 * empty/unreadable. */
export async function retrieveCapabilities(
  prose: string,
  k: number = CAPABILITY_SURFACE_K
): Promise<SurfacedCapability[] | null> {
  const embedder = fetchEmbedder();
  if (!embedder) return null;
  const corpus = await loadCapabilityCorpus();
  if (corpus.length === 0) return [];
  const byType = new Map(corpus.map((c) => [c.type, c]));
  const index = await buildCapabilityIndex(corpus, embedder);
  const hits = await index.retrieve(prose, k);
  return hits.map((h) => {
    const c = byType.get(h.type);
    return { type: h.type, summary: c?.description ?? c?.postcondition ?? '' };
  });
}

/** Render the advisory capability section, or `null` to omit it (no endpoint
 * configured, or nothing matched). */
export function renderCapabilities(caps: SurfacedCapability[] | null): string | null {
  if (!caps || caps.length === 0) return null;
  const lines = caps.map((c) => `- **${c.type}** — ${c.summary}`);
  return (
    `Capabilities that may fit this work (advisory — pre-built procedures you can run; ` +
    `ignore any that don't apply):\n${lines.join('\n')}`
  );
}

/** The reasoning provider used to concern-tag practices. Defaults to Anthropic
 * (unchanged behaviour); `AIGENCY_REASONING_PROVIDER` selects another. Each
 * provider's `chat` is interchangeable — the same `(ChatOptions) => ChatReply`
 * shape — and reads its own key env, so tagging is no longer Anthropic-pinned.
 * (Interim mcp-local convention; align with STDIO-332's account-level routing
 * when it lands — this env is the seam.) */
type ChatFn = (options: ChatOptions) => Promise<ChatReply>;

const REASONING_PROVIDERS: Record<
  string,
  { keyEnv: string; load: () => Promise<{ chat: ChatFn }> }
> = {
  anthropic: { keyEnv: 'ANTHROPIC_API_KEY', load: () => import('@verevoir/llm/anthropic') },
  google: { keyEnv: 'GEMINI_API_KEY', load: () => import('@verevoir/llm/google') },
  openai: { keyEnv: 'OPENAI_API_KEY', load: () => import('@verevoir/llm/openai') },
  deepseek: { keyEnv: 'DEEPSEEK_API_KEY', load: () => import('@verevoir/llm/deepseek') },
  samba: { keyEnv: 'SAMBA_NOVA_API_KEY', load: () => import('@verevoir/llm/samba') },
  mistral: { keyEnv: 'MISTRAL_API_KEY', load: () => import('@verevoir/llm/mistral') },
};

/** Resolve the configured reasoning provider, falling back to Anthropic when
 * `AIGENCY_REASONING_PROVIDER` is unset or names an unknown provider. */
export function reasoningProvider(): {
  name: string;
  keyEnv: string;
  load: () => Promise<{ chat: ChatFn }>;
} {
  const requested = (process.env.AIGENCY_REASONING_PROVIDER?.trim() || 'anthropic').toLowerCase();
  const name = REASONING_PROVIDERS[requested] ? requested : 'anthropic';
  return { name, ...REASONING_PROVIDERS[name] };
}

/** Provision the practice frame for a piece of work. FOUNDATIONAL floor always;
 * concern-tagged practices too when the configured reasoning provider's key is
 * set (one reasoning call, on any provider). A failed tagging call degrades to
 * the floor rather than erroring — consultation is advisory and must never block
 * the work. */
export async function provisionFrame(prose: string): Promise<string> {
  const { name, keyEnv, load } = reasoningProvider();
  const apiKey = process.env[keyEnv]?.trim() || null;
  let ids: string[];
  let note: string;
  if (apiKey) {
    try {
      const { chat } = await load();
      ids = await provisionPractices({ prose }, apiKey, 'reasoning', chat);
      note = `concern-tagged for this work (${name})`;
    } catch (err) {
      ids = [...FOUNDATIONAL];
      note = `foundational floor only — concern-tagging failed (${String(err)})`;
    }
  } else {
    ids = [...FOUNDATIONAL];
    note = `foundational floor only — set ${keyEnv} to add concern-specific practices`;
  }
  const loaded = await loadPracticeBodies(ids);
  const practicesText = renderFrame(loaded, ids, note);
  // Advisory capability surfacing (embedding-only; omitted when no embeddings
  // endpoint is configured, and never allowed to block the practices).
  const capsText = renderCapabilities(await retrieveCapabilities(prose).catch(() => null));
  return capsText ? `${capsText}\n\n===\n\n${practicesText}` : practicesText;
}

/** Register the `provision` tool — the triggered, one-hop "consult the bar"
 * step that returns the practices a piece of work is held to, as text. */
export function registerProvisionTool(server: McpServer): void {
  server.registerTool(
    'provision',
    {
      description:
        "Before you implement or change code, call `provision` with a short description of the work you're about to do. It returns, in one call: the **practices your output is held to** as text (a foundational floor always, plus concern-specific practices tagged for this work), and — when an embeddings endpoint is configured — any **pre-built capabilities that may fit** the work (advisory; run them or ignore them). So you don't have to hunt the governance index. If you delegate the work to another (especially a cheaper) model, pass the returned frame in that worker's prompt: a floor worker won't fetch the bar itself, so it must travel with the task.",
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
