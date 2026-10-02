/**
 * LOU-U1: every 'ai'-SDK-backed provider type sends the configured model to
 * the underlying generateText()/streamText() call.
 *
 * Precedence per call: explicit call model > constructor `defaultModel` >
 * the provider's built-in default. Mocks the 'ai' SDK boundary only.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const generateTextMock = vi.fn();
const streamTextMock = vi.fn();

vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai');
  return {
    ...actual,
    generateText: (...args: unknown[]) => generateTextMock(...args),
    streamText: (...args: unknown[]) => streamTextMock(...args),
  };
});

// On ai 6/7 OllamaProvider loads ollama-ai-provider-v2 (LOU-D28d), which needs zod 4. Where it is
// installed (the ai6-zod4 / ai7-zod4 CI jobs, LOU-M8) the real package builds the model; where it is
// not, generateText is mocked anyway, so a stand-in model does.
vi.mock('ollama-ai-provider-v2', async (importActual) => {
  try {
    return await importActual<object>();
  } catch {
    return { createOllama: () => (modelId: string) => ({ modelId }) };
  }
});

import { OpenAIProvider } from './OpenAIProvider';
import { AnthropicProvider } from './AnthropicProvider';
import { OllamaProvider } from './OllamaProvider';
import { OpenRouterProvider } from './OpenRouterProvider';
import { resolveProvider } from './resolveProvider';
import './index'; // registers the real provider types
import type { LLMProvider } from './llm';

const usage = { promptTokens: 1, completionTokens: 2, totalTokens: 3 };
const messages = [{ role: 'user' as const, content: 'hi' }];

interface ProviderCase {
  type: string;
  build: (defaultModel?: string) => LLMProvider;
  configured: string;
  builtIn: string;
}

const cases: ProviderCase[] = [
  {
    type: 'openai',
    build: (defaultModel) => new OpenAIProvider({ apiKey: 'k', defaultModel }),
    configured: 'gpt-4o-mini',
    builtIn: 'gpt-4',
  },
  {
    type: 'anthropic',
    build: (defaultModel) => new AnthropicProvider({ apiKey: 'k', defaultModel }),
    configured: 'claude-sonnet-5',
    builtIn: 'claude-3-5-sonnet-latest',
  },
  {
    type: 'ollama',
    build: (defaultModel) => new OllamaProvider({ defaultModel }),
    configured: 'qwen2.5',
    builtIn: 'llama3.1',
  },
  {
    type: 'openrouter',
    build: (defaultModel) => new OpenRouterProvider({ apiKey: 'k', defaultModel }),
    configured: 'anthropic/claude-sonnet-5',
    builtIn: 'openai/gpt-3.5-turbo',
  },
];

describe.each(cases)('$type provider model selection', ({ build, configured, builtIn }) => {
  beforeEach(() => {
    generateTextMock.mockReset();
    streamTextMock.mockReset();
    generateTextMock.mockResolvedValue({ text: 'ok', finishReason: 'stop', usage });
  });

  it('sends the constructor defaultModel when the call names no model', async () => {
    const provider = build(configured);

    await provider.generate({ messages });

    expect(generateTextMock.mock.calls[0][0].model.modelId).toBe(configured);
    expect(provider.defaultModel).toBe(configured);
  });

  it('sends the explicit per-call model over the defaultModel', async () => {
    await build(configured).generate({ model: 'explicit-model', messages });

    expect(generateTextMock.mock.calls[0][0].model.modelId).toBe('explicit-model');
  });

  it("falls back to the provider's own default when nothing is configured", async () => {
    const provider = build();

    await provider.generate({ messages });

    expect(generateTextMock.mock.calls[0][0].model.modelId).toBe(builtIn);
    expect(provider.defaultModel).toBe(builtIn);
  });

  it('uses the configured model for stream() too', async () => {
    streamTextMock.mockResolvedValue({
      textStream: (async function* () {})(),
      text: Promise.resolve(''),
      usage: Promise.resolve(usage),
      finishReason: Promise.resolve('stop'),
      toolCalls: Promise.resolve([]),
    });

    await build(configured).stream({ messages });

    expect(streamTextMock.mock.calls[0][0].model.modelId).toBe(configured);
  });
});

describe('resolveProvider model selection', () => {
  beforeEach(() => {
    generateTextMock.mockReset();
    generateTextMock.mockResolvedValue({ text: 'ok', finishReason: 'stop', usage });
  });

  it("honors the model in 'openai/gpt-4o-mini'", async () => {
    vi.stubEnv('OPENAI_API_KEY', 'k');
    try {
      await resolveProvider('openai/gpt-4o-mini').generate({ messages });
    } finally {
      vi.unstubAllEnvs();
    }

    expect(generateTextMock.mock.calls[0][0].model.modelId).toBe('gpt-4o-mini');
  });
});
