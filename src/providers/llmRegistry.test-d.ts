import { describe, it, expectTypeOf } from 'vitest';
import { LLMProviderRegistry, type LLMProvider, type LLMProviderConfig, type ProviderFactory } from '../index';

interface BedrockConfig extends LLMProviderConfig {
  region: string;
}

declare function bedrockProvider(config: BedrockConfig): LLMProvider;

describe('LLMProviderRegistry types (custom providers)', () => {
  it('registers a factory that takes its own config type, without a cast', () => {
    LLMProviderRegistry.register('bedrock', (config: BedrockConfig) => bedrockProvider(config));
    LLMProviderRegistry.register<BedrockConfig>('bedrock', (config) => {
      expectTypeOf(config.region).toEqualTypeOf<string>();
      return bedrockProvider(config);
    });
    // A plain factory still works.
    LLMProviderRegistry.register('plain', (config) => {
      expectTypeOf(config).toEqualTypeOf<LLMProviderConfig>();
      return bedrockProvider({ ...config, region: 'us-east-1' });
    });
  });

  it("creates with the provider's own options", () => {
    expectTypeOf(LLMProviderRegistry.create('bedrock', { apiKey: 'k', region: 'eu-west-1' })).toEqualTypeOf<LLMProvider>();
    LLMProviderRegistry.create<BedrockConfig>('bedrock', { region: 'eu-west-1', defaultModel: 'm' });
    LLMProviderRegistry.create('bedrock', { region: 'eu-west-1' });
    LLMProviderRegistry.create('openai', { apiKey: 'k' });
    // @ts-expect-error a missing required option of the named config
    LLMProviderRegistry.create<BedrockConfig>('bedrock', { apiKey: 'k' });
    // @ts-expect-error a base option with the wrong type
    LLMProviderRegistry.create('openai', { apiKey: 1 });
  });

  it('ProviderFactory takes the config type', () => {
    expectTypeOf<ProviderFactory<BedrockConfig>>().parameter(0).toEqualTypeOf<BedrockConfig>();
    expectTypeOf<ProviderFactory>().parameter(0).toEqualTypeOf<LLMProviderConfig>();
  });
});
