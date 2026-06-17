import { describe, it, expect, afterEach } from 'vitest';
import { registerModelCatalog, registerProviderConnection } from '@verevoir/llm';
import { tierModel } from '../src/tiers.js';

describe('tierModel (STDIO-380)', () => {
  afterEach(() => {
    delete process.env.AIGENCY_MODEL_EXTRACTION;
    delete process.env.TIER_TEST_KEY;
  });

  it('returns null when the tier env is unset', async () => {
    delete process.env.AIGENCY_MODEL_EXTRACTION;
    expect(await tierModel('extraction')).toBeNull();
  });

  it('resolves AIGENCY_MODEL_EXTRACTION (a family) to a usable connection', async () => {
    registerModelCatalog([
      {
        provider: 'tiertest',
        family: 'tiertest-mini',
        modelClass: 'extraction',
        currentId: 'tiertest-mini-1',
        rates: [0.1, 0.2],
        label: 'TierTest Mini',
        prefixes: ['tiertest'],
      },
    ]);
    registerProviderConnection({
      provider: 'tiertest',
      apiKeyEnv: 'TIER_TEST_KEY',
      defaultBaseUrl: 'https://tier.example/v1',
    });
    process.env.TIER_TEST_KEY = 'k';
    process.env.AIGENCY_MODEL_EXTRACTION = 'tiertest';

    const conn = await tierModel('extraction');
    expect(conn).toMatchObject({
      provider: 'tiertest',
      modelId: 'tiertest-mini-1',
      baseUrl: 'https://tier.example/v1',
      apiKey: 'k',
    });
  });

  it('returns null when the tier model is configured but its provider has no key', async () => {
    process.env.AIGENCY_MODEL_EXTRACTION = 'tiertest';
    delete process.env.TIER_TEST_KEY; // provider not configured
    expect(await tierModel('extraction')).toBeNull();
  });
});
