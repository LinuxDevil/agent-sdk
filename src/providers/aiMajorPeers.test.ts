/**
 * Provider packages follow the installed `ai` major (LOU-D28d): the peer
 * ranges in package.json, the install hint of a missing provider package,
 * and which Ollama package OllamaProvider loads. The `ai` v6/v7 cases give a
 * provider the aliased `ai-v7` module (or a v6-shaped stand-in) instead of
 * the installed one.
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as aiV7 from 'ai-v7';
import { aiMajorOf, type AiSdkModule } from './aiSdkCompat';
import { installedAiMajor } from './aiMajor.testkit';
import { AI_RANGES, listProviders, peerInstallCommand, type AiMajor } from './providerSpec';

/** A module shaped like `ai` v6: `stepCountIs`, but no v7-only `registerTelemetry`. */
const aiV6Like = { ...aiV4Stub(), stepCountIs: () => undefined } as AiSdkModule;

function aiV4Stub(): AiSdkModule {
  const fail = () => {
    throw new Error('not called in these tests');
  };
  return { generateText: fail, streamText: fail, jsonSchema: fail };
}

const AI_MODULES: Record<AiMajor, () => AiSdkModule> = { 4: aiV4Stub, 6: () => aiV6Like, 7: () => aiV7 };

const messages = [{ role: 'user' as const, content: 'hi' }];

afterEach(() => {
  vi.doUnmock('@ai-sdk/openai');
  vi.doUnmock('ollama-ai-provider');
  vi.doUnmock('ollama-ai-provider-v2');
  vi.resetModules();
});

describe('aiMajorOf', () => {
  it.each([4, 6, 7] as const)('detects ai %i', (major) => {
    expect(aiMajorOf(AI_MODULES[major]())).toBe(major);
  });

  it('agrees with the installed ai package manifest', async () => {
    expect(aiMajorOf(await import('ai'))).toBe(installedAiMajor);
  });
});

describe('package.json peer ranges', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  const alternatives = (range: string) => range.split('||').map((part) => part.trim());

  it('accepts every supported ai major', () => {
    expect(alternatives(manifest.peerDependencies.ai)).toEqual(Object.values(AI_RANGES));
  });

  it.each(listProviders())('covers every pairing of the $name provider package, as an optional peer', ({ peers }) => {
    for (const pairing of Object.values(peers)) {
      const declared = alternatives(manifest.peerDependencies[pairing.name]);
      expect(declared).toEqual(expect.arrayContaining(alternatives(pairing.accepts)));
      expect(manifest.peerDependenciesMeta[pairing.name]).toEqual({ optional: true });
    }
  });
});

describe('peerInstallCommand', () => {
  it.each([
    [4, 'npm install @ai-sdk/openai@^0.0.42'],
    [6, 'npm install @ai-sdk/openai@^3.0.0'],
    [7, 'npm install @ai-sdk/openai@^4.0.0'],
  ] as const)('names the @ai-sdk/openai major that pairs with ai %i', (major, command) => {
    expect(peerInstallCommand('@ai-sdk/openai', major)).toBe(command);
  });

  it('falls back to a plain install for a package that is not a provider peer', () => {
    expect(peerInstallCommand('left-pad', 7)).toBe('npm install left-pad');
  });
});

function moduleNotFound(packageName: string): Error {
  return Object.assign(new Error(`Cannot find module '${packageName}'`), { code: 'MODULE_NOT_FOUND' });
}

async function ollamaOn(ai: AiSdkModule) {
  const provider = new (await import('./OllamaProvider')).OllamaProvider({ name: 'ollama', maxRetries: 0 });
  Object.assign(provider, { ai });
  return provider as unknown as { createModel(id: string): Promise<unknown>; generate(o: { messages: typeof messages }): Promise<unknown> };
}

describe('a missing provider package on ai 6/7', () => {
  it('OpenAIProvider on ai 7 asks for @ai-sdk/openai 4', async () => {
    vi.resetModules();
    vi.doMock('@ai-sdk/openai', () => {
      throw moduleNotFound('@ai-sdk/openai');
    });
    const provider = new (await import('./OpenAIProvider')).OpenAIProvider({ name: 'openai', apiKey: 'k', maxRetries: 0 });
    Object.assign(provider, { ai: aiV7 });

    await expect(provider.generate({ messages })).rejects.toMatchObject({
      name: 'MissingPeerDependencyError',
      packageName: '@ai-sdk/openai',
      installCommand: 'npm install @ai-sdk/openai@^4.0.0',
    });
  });

  it.each([
    [6, '^3.0.0'],
    [7, '^4.0.0'],
  ] as const)('OllamaProvider on ai %i asks for ollama-ai-provider-v2 %s and states the zod 4 limitation', async (major, range) => {
    vi.resetModules();
    vi.doMock('ollama-ai-provider-v2', () => {
      throw moduleNotFound('ollama-ai-provider-v2');
    });

    const error = await (await ollamaOn(AI_MODULES[major]())).generate({ messages }).catch((e: unknown) => e);

    expect(error).toMatchObject({
      name: 'MissingPeerDependencyError',
      code: 'LOUSHO_PEER_MISSING',
      packageName: 'ollama-ai-provider-v2',
      installCommand: `npm install ollama-ai-provider-v2@${range}`,
    });
    expect((error as Error).message).toMatch(/needs zod 4.*ollama-ai-provider@\^1\.2\.0/);
  });
});

describe('the Ollama package OllamaProvider loads', () => {
  function mockOllama(packageName: string) {
    const model = vi.fn((id: string, settings?: object) => ({ id, settings }));
    const createOllama = vi.fn(() => model);
    vi.resetModules();
    vi.doMock(packageName, () => ({ createOllama }));
    return { createOllama, model };
  }

  it('ai 4: ollama-ai-provider, with the v1 model settings', async () => {
    const { createOllama, model } = mockOllama('ollama-ai-provider');
    await (await ollamaOn(aiV4Stub())).createModel('llama3');
    expect(createOllama).toHaveBeenCalledWith({ baseURL: 'http://localhost:11434/api' });
    expect(model).toHaveBeenCalledWith('llama3', { simulateStreaming: true, structuredOutputs: true });
  });

  it('ai 7: ollama-ai-provider-v2, which takes no model settings', async () => {
    const { createOllama, model } = mockOllama('ollama-ai-provider-v2');
    await (await ollamaOn(aiV7)).createModel('llama3');
    expect(createOllama).toHaveBeenCalledWith({ baseURL: 'http://localhost:11434/api' });
    expect(model).toHaveBeenCalledWith('llama3');
  });
});
