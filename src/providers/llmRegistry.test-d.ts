import { describe, it, expectTypeOf } from 'vitest';
import { LLMProviderRegistry, type LLMProvider, type LLMProviderConfig, type OpenAIProviderConfig, type ProviderFactory } from '../index';

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

  it("checks a built-in provider's config against its own type", () => {
    LLMProviderRegistry.create('openai', { apiKey: 'k', baseURL: 'https://api.example.com/v1' });
    LLMProviderRegistry.create('anthropic', { apiKey: 'k', defaultModel: 'claude-sonnet-5-5' });
    LLMProviderRegistry.create('ollama', { baseURL: 'http://localhost:11434' });
    LLMProviderRegistry.create('mock', { responses: ['hi'] });
    LLMProviderRegistry.create('OpenAI', { apiKey: 'k' });
    // @ts-expect-error a typo of a built-in provider's option
    LLMProviderRegistry.create('openai', { apiKey: 'k', baseUrl: 'typo' });
    // @ts-expect-error a typo, whatever the name's case
    LLMProviderRegistry.create('Anthropic', { apiKey: 'k', apikey: 'typo' });
    // @ts-expect-error an option of another built-in provider
    LLMProviderRegistry.create('ollama', { responses: ['hi'] });
    // @ts-expect-error an option of a custom provider
    LLMProviderRegistry.create('openai', { apiKey: 'k', region: 'eu-west-1' });
    // A name only known at runtime takes any config, as for custom providers.
    const name: string = 'openai';
    LLMProviderRegistry.create(name, { apiKey: 'k', region: 'eu-west-1' });
    // An explicit config type still applies to a built-in name.
    LLMProviderRegistry.create<OpenAIProviderConfig>('openai', { apiKey: 'k' });
  });

  it('keeps a custom provider on its own config type', () => {
    LLMProviderRegistry.create('bedrock', { apiKey: 'k', region: 'eu-west-1', anything: true });
    // @ts-expect-error a typo against the named custom config
    LLMProviderRegistry.create<BedrockConfig>('bedrock', { region: 'eu-west-1', regoin: 'typo' });
    // @ts-expect-error a base option with the wrong type
    LLMProviderRegistry.create('bedrock', { region: 'eu-west-1', apiKey: 1 });
  });

  it('ProviderFactory takes the config type', () => {
    expectTypeOf<ProviderFactory<BedrockConfig>>().parameter(0).toEqualTypeOf<BedrockConfig>();
    expectTypeOf<ProviderFactory>().parameter(0).toEqualTypeOf<LLMProviderConfig>();
  });
});
