import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { registerModelCatalog } from '@verevoir/llm';
import { meterFooter, resolveMeterMode, roundUsage } from '../src/metering.js';

describe('meterFooter (STDIO-385)', () => {
  beforeAll(() => {
    registerModelCatalog([
      {
        provider: 'samba',
        family: 'mtr-deepseek',
        modelClass: 'extraction',
        currentId: 'DeepSeek-V3.2',
        rates: [0.6, 1.5],
        label: 'DeepSeek V3.2',
        prefixes: ['DeepSeek-V3'],
      },
    ]);
  });

  it('appends nothing for mode "none"', () => {
    expect(meterFooter([roundUsage('DeepSeek-V3.2', 1000, 500)], 'none')).toBe('');
  });

  it('appends nothing when there are no rounds', () => {
    expect(meterFooter([], 'totals-only')).toBe('');
  });

  it('"totals-only" appends a total table with the concrete model, class, tokens, and a price', () => {
    const out = meterFooter([roundUsage('DeepSeek-V3.2', 1000, 500)], 'totals-only');
    expect(out).toContain('metering total');
    expect(out).toContain('DeepSeek V3.2');
    expect(out).toContain('(extraction)');
    expect(out).toMatch(/\$\d/); // a real price, not $0
    expect(out).not.toContain('metering by stage');
  });

  it('"verbose" adds a line per stage plus the total', () => {
    const out = meterFooter(
      [roundUsage('DeepSeek-V3.2', 1000, 500), roundUsage('DeepSeek-V3.2', 200, 100)],
      'verbose',
      ['grep', 'read_file']
    );
    expect(out).toContain('metering by stage');
    expect(out).toContain('grep:');
    expect(out).toContain('read_file:');
    expect(out).toContain('metering total');
  });
});

describe('resolveMeterMode (STDIO-387)', () => {
  afterEach(() => {
    delete process.env.AIGENCY_METER;
  });

  it('uses an explicit per-call mode over the env default', () => {
    process.env.AIGENCY_METER = 'verbose';
    expect(resolveMeterMode('totals-only')).toBe('totals-only');
  });

  it('falls back to the AIGENCY_METER env when no explicit mode is given', () => {
    process.env.AIGENCY_METER = 'verbose';
    expect(resolveMeterMode()).toBe('verbose');
  });

  it('defaults to none when neither an explicit mode nor the env is set', () => {
    delete process.env.AIGENCY_METER;
    expect(resolveMeterMode()).toBe('none');
  });

  it('ignores an unrecognised env value rather than honouring a typo', () => {
    process.env.AIGENCY_METER = 'loud';
    expect(resolveMeterMode()).toBe('none');
  });
});
