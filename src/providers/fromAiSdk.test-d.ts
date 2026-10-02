import { describe, it, expectTypeOf } from 'vitest';
import type { LanguageModel } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createAgent, type CreateAgentConfig } from '../createAgent';
import { fromAiSdk, type FromAiSdkOptions, type LLMProvider } from '../index';

const model = createOpenAI({ apiKey: 'k' }).chat('gpt-4o-mini');

describe('fromAiSdk() types (M2)', () => {
  it("takes the installed ai's LanguageModel and returns an LLMProvider that createAgent's provider accepts", () => {
    expectTypeOf(fromAiSdk).parameter(0).toEqualTypeOf<LanguageModel>();
    expectTypeOf(fromAiSdk(model)).toEqualTypeOf<LLMProvider>();
    expectTypeOf(fromAiSdk(model)).toMatchTypeOf<NonNullable<Extract<CreateAgentConfig, { provider: LLMProvider }>['provider']>>();
    createAgent({ provider: fromAiSdk(model, { name: 'openai' }) });
  });

  it('takes the documented options', () => {
    expectTypeOf<FromAiSdkOptions>().toEqualTypeOf<{
      name?: string;
      fileMediaTypes?: readonly string[];
      replaysReasoning?: boolean;
      maxRetries?: number;
    }>();
    // @ts-expect-error an unknown option
    fromAiSdk(model, { model: 'other' });
  });
});
