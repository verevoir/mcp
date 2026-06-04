// Skill descriptors loaded from a guardrails corpus (`corpus/skills/*.md`,
// the same source the aigency web app reads). A skill is a `.md` with flat
// frontmatter + an instruction body. We expose the *reasoning* skills as MCP
// prompts (see tools/skills.ts) so an MCP client — Claude Code on a Max plan,
// say — can invoke and chain them on its own tokens rather than the web app's
// metered API.
//
// This is a deliberately minimal port of the web app's skill parser, enough
// to register prompts. The shared definition will be extracted to a
// `@verevoir/skills` library so both consumers use one parser (follow-up);
// until then this is the proving copy.

export interface SkillInput {
  /** Argument name (becomes the prompt argument name). */
  name: string;
  /** Whether the argument is required. */
  required: boolean;
  /** Human description, shown to the client. */
  description: string;
}

export interface SkillDescriptor {
  /** Canonical id; matches the descriptor filename stem. */
  id: string;
  /** Human-facing capability name. */
  name: string;
  /** One-line summary the client reads when choosing the prompt. */
  description: string;
  /** Typed input contract → the prompt's arguments. */
  inputs: SkillInput[];
  /** Native handler name. When set, the skill is deterministic code (e.g.
   * `fetch_url`) rather than a reasoning prompt — these are NOT exposed as
   * prompts (the host typically already has the capability). */
  handler?: string;
  /** The instruction body — the prompt the host model executes. */
  instructions: string;
}

export class SkillParseError extends Error {}

const REQUIRED_KEYS = ['id', 'name', 'description'] as const;

function splitFrontmatter(raw: string): { frontmatter: string[]; body: string } {
  const lines = raw.split('\n');
  if (lines[0]?.trim() !== '---') {
    throw new SkillParseError("descriptor must begin with a '---' fence");
  }
  const end = lines.indexOf('---', 1);
  if (end === -1) {
    throw new SkillParseError("descriptor frontmatter has no closing '---'");
  }
  return {
    frontmatter: lines.slice(1, end),
    body: lines
      .slice(end + 1)
      .join('\n')
      .trim(),
  };
}

function unquote(value: string): string {
  const v = value.trim();
  const wrapped = (v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"));
  return wrapped ? v.slice(1, -1) : v;
}

// One `inputs:` block-list line → a SkillInput. Tolerant of an em-dash or
// `--`/`-` description separator; `(required)` marks a required argument.
//   - <name>: <type> (required) — <description>
function parseInputLine(line: string): SkillInput | null {
  const item = line.trim().replace(/^-\s+/, '').trim();
  const colon = item.indexOf(':');
  if (colon === -1) return null;
  const name = item.slice(0, colon).trim();
  if (!name) return null;
  const rest = item.slice(colon + 1).trim();

  let description = '';
  let meta = rest;
  const dash = rest.search(/\s+(—|--)\s+/);
  if (dash !== -1) {
    meta = rest.slice(0, dash).trim();
    description = rest.replace(/^.*?\s+(—|--)\s+/, '').trim();
  }
  const required = /\(required\)/i.test(meta);
  return { name, required, description };
}

/** Parse a skill descriptor `.md` into a SkillDescriptor. Hand-parsed, no YAML
 * dependency, matching the descriptor convention. */
export function parseSkill(idHint: string, raw: string): SkillDescriptor {
  const { frontmatter, body } = splitFrontmatter(raw);

  const scalars: Record<string, string> = {};
  const inputs: SkillInput[] = [];

  for (let i = 0; i < frontmatter.length; i++) {
    const line = frontmatter[i];
    if (!line.trim()) continue;

    if (line.trim() === 'inputs:') {
      for (let j = i + 1; j < frontmatter.length; j++) {
        if (!/^\s*-\s+/.test(frontmatter[j])) {
          i = j - 1;
          break;
        }
        const parsed = parseInputLine(frontmatter[j]);
        if (parsed) inputs.push(parsed);
        i = j;
      }
      continue;
    }

    const colon = line.indexOf(':');
    if (colon === -1) continue;
    scalars[line.slice(0, colon).trim()] = unquote(line.slice(colon + 1));
  }

  for (const k of REQUIRED_KEYS) {
    if (!scalars[k]) {
      throw new SkillParseError(`descriptor missing required field: ${k}`);
    }
  }
  if (scalars.id !== idHint) {
    throw new SkillParseError(
      `skill id '${scalars.id}' does not match filename '${idHint}' — rename one to match`
    );
  }

  return {
    id: scalars.id,
    name: scalars.name,
    description: scalars.description,
    inputs,
    handler: scalars.handler?.trim() || undefined,
    instructions: body,
  };
}

/** Reasoning skills (no native handler) are the ones exposed as prompts; a
 * handler-backed skill is deterministic code the host usually already has. */
export function isReasoningSkill(skill: SkillDescriptor): boolean {
  return !skill.handler;
}

/** Render the prompt body the host model executes: the skill's instructions
 * followed by the supplied argument values. Only non-empty args are included,
 * so optional arguments left blank don't clutter the prompt. */
export function renderSkillPrompt(
  skill: SkillDescriptor,
  args: Record<string, string | undefined>
): string {
  const supplied = skill.inputs
    .map((input) => ({ input, value: args[input.name]?.trim() }))
    .filter((x) => x.value);

  if (supplied.length === 0) return skill.instructions;

  const inputBlock = supplied.map(({ input, value }) => `### ${input.name}\n${value}`).join('\n\n');

  return `${skill.instructions}\n\n---\n\n## Inputs\n\n${inputBlock}`;
}
