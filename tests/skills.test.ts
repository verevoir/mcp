import { describe, it, expect } from 'vitest';
import { parseSkill, isReasoningSkill, renderSkillPrompt, SkillParseError } from '../src/skills.js';

const REASONING = `---
id: analyse_contract_risk
name: Analyse Contract Risk
description: Surface risky clauses with severity and mitigations.
model_class: reasoning
inputs:
  - contract_text: string (required) — the full contract text
  - party: string — which party you advise
---
You are a commercial contracts risk reviewer. Identify risky clauses.`;

const DETERMINISTIC = `---
id: fetch_url
name: Fetch URL
description: Fetch a URL and extract its text.
handler: fetchUrl
---
(native handler)`;

describe('parseSkill', () => {
  it('parses a reasoning skill into id, name, inputs, and body', () => {
    const skill = parseSkill('analyse_contract_risk', REASONING);
    expect(skill.id).toBe('analyse_contract_risk');
    expect(skill.name).toBe('Analyse Contract Risk');
    expect(skill.inputs.map((i) => i.name)).toEqual(['contract_text', 'party']);
    expect(skill.inputs.find((i) => i.name === 'contract_text')?.required).toBe(true);
    expect(skill.inputs.find((i) => i.name === 'party')?.required).toBe(false);
    expect(skill.instructions).toContain('risk reviewer');
    expect(isReasoningSkill(skill)).toBe(true);
  });

  it('treats a handler-backed skill as deterministic, not a reasoning prompt', () => {
    const skill = parseSkill('fetch_url', DETERMINISTIC);
    expect(skill.handler).toBe('fetchUrl');
    expect(isReasoningSkill(skill)).toBe(false);
  });

  it('rejects a descriptor whose id does not match the filename', () => {
    expect(() => parseSkill('wrong_name', REASONING)).toThrow(SkillParseError);
  });

  it('rejects a descriptor missing a required field', () => {
    const noDesc = `---\nid: x\nname: X\n---\nbody`;
    expect(() => parseSkill('x', noDesc)).toThrow(/description/);
  });
});

describe('renderSkillPrompt', () => {
  const skill = parseSkill('analyse_contract_risk', REASONING);

  it('appends only the supplied non-empty inputs under the instructions', () => {
    const text = renderSkillPrompt(skill, {
      contract_text: 'THE AGREEMENT...',
      party: '',
    });
    expect(text).toContain('risk reviewer'); // instructions retained
    expect(text).toContain('### contract_text');
    expect(text).toContain('THE AGREEMENT...');
    expect(text).not.toContain('### party'); // blank optional omitted
  });

  it('returns the bare instructions when no inputs are supplied', () => {
    expect(renderSkillPrompt(skill, {})).toBe(skill.instructions);
  });
});
