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

  it('runs the gate AND the reasoning review, staged, for a gated capability', async () => {
    const delegateFn = vi.fn().mockResolvedValue('TOKENS');
    // gate: first call fails on structure, second call passes.
    const gate = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, findings: [{ kind: 'DTCG', message: 'bad structure' }] })
      .mockResolvedValueOnce({ ok: true, findings: [] });
    const resolveVerifierFn = vi.fn().mockResolvedValue(gate);
    const reviewVerifier = vi
      .fn()
      .mockResolvedValue({ ok: false, findings: [{ kind: 'REVIEW', message: 'wrong values' }] });
    const makeReasoningReviewerFn = vi
      .fn()
      .mockResolvedValue({ model: 'opus', verifier: reviewVerifier, usage: () => [] });

    const out = await enactCapability(
      { capability: 'convert-design-system', directive: 'Convert GOV.UK.' },
      delegateFn,
      async () => CORPUS,
      resolveVerifierFn as never,
      makeReasoningReviewerFn as never
    );
    expect(resolveVerifierFn).toHaveBeenCalledWith('design-pack', 'convert-design-system');
    const makeReviewer = delegateFn.mock.calls[0][3] as (a?: string) => Promise<{
      verifier: (i: unknown) => Promise<{ ok: boolean; findings: { kind: string }[] }>;
      model: string;
    }>;
    const reviewer = await makeReviewer('work');
    const vin = { capability: 'c', verify: 'design-pack', result: '{}' };

    // Structure fails → review is NOT spent, gate findings returned.
    const v1 = await reviewer.verifier(vin);
    expect(v1.ok).toBe(false);
    expect(v1.findings[0].kind).toBe('DTCG');
    expect(reviewVerifier).not.toHaveBeenCalled();

    // Structure passes → the reasoning review runs and its findings surface.
    const v2 = await reviewer.verifier(vin);
    expect(reviewVerifier).toHaveBeenCalledOnce();
    expect(v2.findings[0].kind).toBe('REVIEW');

    expect(reviewer.model).toContain('design-pack gate');
    expect(reviewer.model).toContain('review');
    expect(out).toContain('design-pack gate + reasoning review');
  });

  it('degrades to gate-only when no reasoning tier is available', async () => {
    const delegateFn = vi.fn().mockResolvedValue('TOKENS');
    const gate = vi.fn().mockResolvedValue({ ok: true, findings: [] });
    const resolveVerifierFn = vi.fn().mockResolvedValue(gate);
    const makeReasoningReviewerFn = vi.fn().mockResolvedValue(null); // no reasoning tier
    await enactCapability(
      { capability: 'convert-design-system', directive: 'x' },
      delegateFn,
      async () => CORPUS,
      resolveVerifierFn as never,
      makeReasoningReviewerFn as never
    );
    const reviewer = await (
      delegateFn.mock.calls[0][3] as (a?: string) => Promise<{
        verifier: (i: unknown) => Promise<{ ok: boolean }>;
        model: string;
      }>
    )('work');
    const v = await reviewer.verifier({ capability: 'c', verify: 'design-pack', result: '{}' });
    expect(v.ok).toBe(true); // gate passed, no review available → clean
    expect(reviewer.model).toContain('design-pack gate');
    expect(reviewer.model).not.toContain('review');
  });

  it('falls back to the reasoning review when no gate is runnable', async () => {
    const delegateFn = vi.fn().mockResolvedValue('TOKENS');
    const resolveVerifierFn = vi.fn().mockResolvedValue(null); // no runnable gate
    const out = await enactCapability(
      { capability: 'convert-design-system', directive: 'x' },
      delegateFn,
      async () => CORPUS,
      resolveVerifierFn as never
    );
    // delegate called WITHOUT the 4th makeReviewer arg → its default reasoning review.
    expect(delegateFn.mock.calls[0].length).toBe(1);
    expect(out).toContain('reasoning tier');
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
