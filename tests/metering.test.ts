import { describe, it, expect, beforeAll } from 'vitest';
import { registerModelCatalog } from '@verevoir/llm';
import { meterFooter, roundUsage } from '../src/metering.js';

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
