/**
 * Google Provider Tests
 *
 * `@ai-sdk/google` is an optional peer this repo does not install, so it is
 * mocked here, together with the 'ai' SDK's generateText (no live API key).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const generateTextMock = vi.fn();
const createGoogleMock = vi.fn();

vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai');
  return { ...actual, generateText: (...args: unknown[]) => generateTextMock(...args) };
});

vi.mock('@ai-sdk/google', () => ({
  createGoogleGenerativeAI: (options: unknown) => createGoogleMock(options),
}));

import { GoogleProvider } from './GoogleProvider';
import { resolveProvider } from './resolveProvider';

describe('GoogleProvider', () => {
  beforeEach(() => {
    generateTextMock.mockReset();
    createGoogleMock.mockReset();
    createGoogleMock.mockImplementation(() => (modelId: string) => ({ fakeModel: modelId }));
    generateTextMock.mockResolvedValue({
      text: 'Hello from Gemini',
      finishReason: 'stop',
      usage: { promptTokens: 4, completionTokens: 3, totalTokens: 7 },
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is named google and defaults to gemini-2.5-flash', () => {
    const provider = new GoogleProvider({ name: 'google', apiKey: 'k' });
    expect(provider.name).toBe('google');
    expect(provider.defaultModel).toBe('gemini-2.5-flash');
    expect(provider.supportsTools('gemini-2.5-pro')).toBe(true);
    expect(provider.supportsStreaming('gemini-2.5-pro')).toBe(true);
  });

  it('builds the @ai-sdk/google model with the configured key, once', async () => {
    const provider = new GoogleProvider({ name: 'google', apiKey: 'test-key', defaultModel: 'gemini-2.5-pro' });

    const result = await provider.generate({ messages: [{ role: 'user', content: 'Hi' }] });
    await provider.generate({ messages: [{ role: 'user', content: 'Hi again' }] });

    expect(result.text).toBe('Hello from Gemini');
    expect(createGoogleMock).toHaveBeenCalledTimes(1);
    expect(createGoogleMock).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'test-key' }));
    expect(generateTextMock.mock.calls[0]?.[0]).toMatchObject({ model: { fakeModel: 'gemini-2.5-pro' } });
  });

  it("is what 'google/<model>' resolves to, with GOOGLE_GENERATIVE_AI_API_KEY as its key", async () => {
    vi.stubEnv('GOOGLE_GENERATIVE_AI_API_KEY', 'env-google-key');

    const provider = resolveProvider('google/gemini-2.5-flash');
    await provider.generate({ messages: [{ role: 'user', content: 'Hi' }] });

    expect(provider).toBeInstanceOf(GoogleProvider);
    expect(provider.defaultModel).toBe('gemini-2.5-flash');
    expect(createGoogleMock).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'env-google-key' }));
  });
});
