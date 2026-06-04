import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { pickSourceAdapter, resolveSourceEnv } from '../router.js';
import {
  parseSkill,
  isReasoningSkill,
  renderSkillPrompt,
  SkillParseError,
  type SkillDescriptor,
} from '../skills.js';

// Expose the guardrails reasoning skills (`corpus/skills/*.md`) as MCP
// prompts. Invoking a prompt returns the skill's instructions + the supplied
// inputs as a user message — so the *host* model (e.g. Claude Code) executes
// it, on its own tokens. Deterministic (handler-backed) skills are not
// exposed: the host usually already has those capabilities (Claude Code has
// its own fetch), and the value here is the reasoning instructions it lacks.
//
// Chaining stays with the host: a client composes several prompts in sequence
// exactly as the web conversation chains the skills.

// The guardrails corpus to read skills from. Canonical by default; override
// for a fork or a per-project corpus.
const DEFAULT_GUARDRAILS_URL = 'https://github.com/verevoir/aigency-guardrails';

function guardrailsUrl(): string {
  return process.env.AIGENCY_GUARDRAILS_URL?.trim() || DEFAULT_GUARDRAILS_URL;
}

// New `corpus/` layout first, then the legacy flat layout (matches the web
// app's dual-path loaders during the guardrails restructure).
const SKILLS_DIRS = ['corpus/skills', 'skills'];

/** Load the reasoning skills from the guardrails corpus. Returns [] when the
 * source is unreadable (e.g. no GITHUB_TOKEN) — the server then starts
 * without skill prompts rather than failing. */
export async function loadReasoningSkills(
  sourceUrl: string = guardrailsUrl()
): Promise<SkillDescriptor[]> {
  let adapter, env;
  try {
    adapter = await pickSourceAdapter(sourceUrl);
    env = resolveSourceEnv(sourceUrl);
  } catch (err) {
    process.stderr.write(`verevoir-mcp: skill prompts unavailable — ${String(err)}\n`);
    return [];
  }

  for (const dir of SKILLS_DIRS) {
    let entries;
    try {
      entries = await adapter.listFiles(env, sourceUrl, dir);
    } catch {
      continue;
    }
    if (!Array.isArray(entries)) continue;

    const skills: SkillDescriptor[] = [];
    for (const entry of entries) {
      if (entry.type !== 'file' || !entry.name.endsWith('.md')) continue;
      const idHint = entry.name.replace(/\.md$/, '');
      try {
        const { content } = await adapter.readFile(env, sourceUrl, entry.path);
        const skill = parseSkill(idHint, content);
        if (isReasoningSkill(skill)) skills.push(skill);
      } catch (err) {
        const why = err instanceof SkillParseError ? err.message : String(err);
        process.stderr.write(`verevoir-mcp: skipping skill ${entry.path} — ${why}\n`);
      }
    }
    if (skills.length > 0) return skills;
  }
  return [];
}

/** Build the prompt argument schema from a skill's typed inputs. MCP prompt
 * arguments are strings; required inputs are required, the rest optional. */
function argsSchema(skill: SkillDescriptor): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const input of skill.inputs) {
    const base = z.string().describe(input.description);
    shape[input.name] = input.required ? base : base.optional();
  }
  return shape;
}

/** Register each reasoning skill as an MCP prompt. Best-effort: a load
 * failure leaves the server running with its other tools/prompts. Returns the
 * number of prompts registered (handy for logging + tests). */
export async function registerSkillPrompts(server: McpServer): Promise<number> {
  const skills = await loadReasoningSkills();
  for (const skill of skills) {
    server.registerPrompt(
      skill.id,
      {
        title: skill.name,
        description: skill.description,
        argsSchema: argsSchema(skill),
      },
      (args) => ({
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: renderSkillPrompt(skill, args as Record<string, string | undefined>),
            },
          },
        ],
      })
    );
  }
  return skills.length;
}
