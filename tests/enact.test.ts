import { describe, it, expect, vi } from 'vitest';
import type { CapabilityDescriptor } from '@verevoir/recipes';
import {
  findDescriptor,
  buildEnactmentPrompt,
  enactmentHeader,
  enactCapability,
} from '../src/tools/enact.js';

/** A minimal descriptor with sensible defaults for the fields enact reads. */
function cap(partial: Partial<CapabilityDescriptor> & { type: string }): CapabilityDescriptor {
  return {
    postcondition: '',
    composes: [],
    nextSteps: [],
    gate: 'none',
    grants: [],
    inputs: [],
    guidance: '',
    ...partial,
  } as CapabilityDescriptor;
}

const CORPUS: CapabilityDescriptor[] = [
  cap({
    type: 'convert-design-system',
    description: 'Turn a design system into tokens and example components.',
    postcondition: 'design tokens and an example site exist',
    output: 'a token set and a runnable example',
    guidance: 'Extract colours, type, spacing as named tokens.',
    verify: 'design-pack',
    gate: 'none',
  }),
  cap({ type: 'scaffold-service' }),
  cap({ type: 'attach-existing-repo', gate: 'assent' }),
];

describe('findDescriptor', () => {
  it('matches an exact type case-insensitively', () => {
    const { descriptor } = findDescriptor('Convert-Design-System', CORPUS);
    expect(descriptor?.type).toBe('convert-design-system');
  });

  it('matches a unique substring', () => {
    const { descriptor } = findDescriptor('scaffold', CORPUS);
    expect(descriptor?.type).toBe('scaffold-service');
  });

  it('returns no descriptor and the type list when nothing matches', () => {
    const { descriptor, types } = findDescriptor('nope', CORPUS);
    expect(descriptor).toBeNull();
    expect(types).toContain('scaffold-service');
  });

  it('does not guess when a substring is ambiguous', () => {
    const corpus = [cap({ type: 'review-code' }), cap({ type: 'review-design' })];
    expect(findDescriptor('review', corpus).descriptor).toBeNull();
  });
});

describe('buildEnactmentPrompt', () => {
  it('folds the capability intent and the directive into one self-contained task', () => {
    const prompt = buildEnactmentPrompt(
      CORPUS[0],
      'Convert the GOV.UK design system.',
      'src: gov.uk'
    );
    expect(prompt).toContain('Capability: convert-design-system');
    expect(prompt).toContain('design tokens and an example site exist'); // postcondition
    expect(prompt).toContain('Extract colours'); // guidance
    expect(prompt).toContain('design-pack'); // named hard postcondition
    expect(prompt).toContain('Convert the GOV.UK design system.'); // directive
    expect(prompt).toContain('src: gov.uk'); // context
  });

  it('omits absent sections without crashing', () => {
    const prompt = buildEnactmentPrompt(cap({ type: 'bare' }), 'do the thing');
    expect(prompt).toContain('Capability: bare');
    expect(prompt).toContain('do the thing');
    expect(prompt).not.toContain('hard postcondition');
  });
});

describe('enactmentHeader', () => {
  it('records that the bar travelled and where it ran', () => {
    const h = enactmentHeader(CORPUS[0], true);
    expect(h).toContain('convert-design-system');
    expect(h).toContain('governed');
    expect(h).toContain('worker tier');
    expect(h).toContain('reasoning tier');
  });

  it('surfaces a non-default gate and an opted-out verify', () => {
    const h = enactmentHeader(CORPUS[2], false);
    expect(h).toContain('gate: assent');
    expect(h).toContain('verify: off');
  });
});

describe('enactCapability', () => {
  it('produces governed + verified by default, threading the descriptor into the delegate prompt', async () => {
    const delegateFn = vi.fn().mockResolvedValue('TOKENS + SITE');
    const out = await enactCapability(
      { capability: 'convert-design-system', directive: 'Convert GOV.UK.' },
      delegateFn,
      async () => CORPUS
    );
    expect(out).toContain('enacted');
    expect(out).toContain('TOKENS + SITE');
    const call = delegateFn.mock.calls[0][0];
    expect(call.governed).toBe(true);
    expect(call.verify).toBe(true); // default on
    expect(call.prompt).toContain('Convert GOV.UK.');
    expect(call.prompt).toContain('convert-design-system');
  });

  it('lets the caller opt out of verify', async () => {
    const delegateFn = vi.fn().mockResolvedValue('draft');
    await enactCapability(
      { capability: 'scaffold-service', directive: 'x', verify: false },
      delegateFn,
      async () => CORPUS
    );
    expect(delegateFn.mock.calls[0][0].verify).toBe(false);
  });

  it('returns the available list (not an error) for an unknown capability', async () => {
    const delegateFn = vi.fn();
    const out = await enactCapability(
      { capability: 'no-such-thing', directive: 'x' },
      delegateFn,
      async () => CORPUS
    );
    expect(out).toContain('No capability matches');
    expect(out).toContain('scaffold-service');
    expect(delegateFn).not.toHaveBeenCalled();
  });

  it('degrades legibly when the corpus is unreadable', async () => {
    const delegateFn = vi.fn();
    const out = await enactCapability(
      { capability: 'anything', directive: 'x' },
      delegateFn,
      async () => [] as CapabilityDescriptor[]
    );
    expect(out).toContain('Could not load the capability corpus');
    expect(delegateFn).not.toHaveBeenCalled();
  });
});
