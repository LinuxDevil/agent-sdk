/**
 * Missing optional peers (LOU-D10, LOU-D19): constructing a provider always
 * works; the first generate()/stream() rejects with a typed error carrying
 * the install command.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { MissingPeerDependencyError, loadOptionalPeer, lazyValue } from './optionalPeer';

function moduleNotFound(packageName: string): Error {
  return Object.assign(new Error(`Cannot find module '${packageName}'`), { code: 'MODULE_NOT_FOUND' });
}

afterEach(() => {
  vi.doUnmock('@ai-sdk/openai');
  vi.doUnmock('@ai-sdk/anthropic');
  vi.doUnmock('ollama-ai-provider');
  vi.doUnmock('dockerode');
  vi.resetModules();
});

const messages = [{ role: 'user' as const, content: 'hi' }];

interface Case {
  label: string;
  packageName: string;
  installCommand: string;
  load: () => Promise<{ generate(o: { messages: typeof messages }): Promise<unknown>; stream(o: { messages: typeof messages }): Promise<unknown> }>;
}

const CASES: Case[] = [
  {
    label: 'OpenAIProvider',
    packageName: '@ai-sdk/openai',
    installCommand: 'npm install @ai-sdk/openai@^0.0.42',
    load: async () => new (await import('./OpenAIProvider')).OpenAIProvider({ name: 'openai', apiKey: 'k' }),
  },
  {
    label: 'OpenRouterProvider',
    packageName: '@ai-sdk/openai',
    installCommand: 'npm install @ai-sdk/openai@^0.0.42',
    load: async () => new (await import('./OpenRouterProvider')).OpenRouterProvider({ name: 'openrouter', apiKey: 'k' }),
  },
  {
    label: 'AnthropicProvider',
    packageName: '@ai-sdk/anthropic',
    installCommand: 'npm install @ai-sdk/anthropic@^0.0.42',
    load: async () => new (await import('./AnthropicProvider')).AnthropicProvider({ name: 'anthropic', apiKey: 'k' }),
  },
  {
    label: 'OllamaProvider',
    packageName: 'ollama-ai-provider',
    installCommand: 'npm install ollama-ai-provider@^1.2.0',
    load: async () => new (await import('./OllamaProvider')).OllamaProvider({ name: 'ollama' }),
  },
];

describe.each(CASES)('$label with its peer not installed', ({ packageName, installCommand, load }) => {
  function mockMissing(): void {
    vi.resetModules();
    vi.doMock(packageName, () => {
      throw moduleNotFound(packageName);
    });
  }

  it('constructs fine and generate() rejects with MissingPeerDependencyError', async () => {
    mockMissing();
    const provider = await load();

    const error = await provider.generate({ messages }).catch((e: unknown) => e);

    // vi.resetModules() gave the provider a fresh copy of the class, so load the same one.
    expect(error).toBeInstanceOf((await import('./optionalPeer')).MissingPeerDependencyError);
    expect(error).toMatchObject({ packageName, installCommand });
    expect((error as Error).message).toContain(`Run: ${installCommand}`);
  });

  it('stream() rejects the same way', async () => {
    mockMissing();
    const provider = await load();

    await expect(provider.stream({ messages })).rejects.toMatchObject({
      name: 'MissingPeerDependencyError',
      packageName,
      installCommand,
    });
  });
});

describe('SubprocessSandbox with dockerode not installed', () => {
  it('constructs fine and run() rejects with MissingPeerDependencyError', async () => {
    vi.resetModules();
    vi.doMock('dockerode', () => {
      throw moduleNotFound('dockerode');
    });
    const { SubprocessSandbox } = await import('../security/sandbox');
    const sandbox = new SubprocessSandbox();

    await expect(sandbox.run('echo', ['hi'])).rejects.toMatchObject({
      name: 'MissingPeerDependencyError',
      packageName: 'dockerode',
      installCommand: 'npm install dockerode',
    });
  });
});

describe('loadOptionalPeer', () => {
  it('rethrows errors that are not a missing package, and a missing transitive module as is', async () => {
    const boom = new Error('boom');
    await expect(loadOptionalPeer('x', () => Promise.reject(boom))).rejects.toBe(boom);

    const transitive = moduleNotFound('some-other-package');
    await expect(loadOptionalPeer('x', () => Promise.reject(transitive))).rejects.toBe(transitive);
  });

  it('recognises an ESM "Cannot find package" error', async () => {
    const esm = Object.assign(new Error("Cannot find package 'x' imported from /app/a.mjs"), {
      code: 'ERR_MODULE_NOT_FOUND',
    });
    await expect(loadOptionalPeer('x', () => Promise.reject(esm))).rejects.toBeInstanceOf(MissingPeerDependencyError);
  });
});

describe('lazyValue', () => {
  it('initialises once, and retries after a failure', async () => {
    const init = vi.fn().mockRejectedValueOnce(new Error('first')).mockResolvedValue('ok');
    const get = lazyValue<string>(init);

    await expect(get()).rejects.toThrow('first');
    expect(await get()).toBe('ok');
    expect(await get()).toBe('ok');
    expect(init).toHaveBeenCalledTimes(2);
  });
});
