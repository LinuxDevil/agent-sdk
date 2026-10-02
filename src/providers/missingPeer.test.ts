/**
 * Missing optional peers (LOU-D10, LOU-D19): constructing a provider always
 * works; the first generate()/stream() rejects with a typed error carrying
 * the install command.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { FEATURE_PEERS, MissingPeerDependencyError, loadOptionalPeer, lazyValue } from './optionalPeer';
import { installedAiMajor } from './aiMajor.testkit';

function moduleNotFound(packageName: string): Error {
  return Object.assign(new Error(`Cannot find module '${packageName}'`), { code: 'MODULE_NOT_FOUND' });
}

afterEach(() => {
  vi.doUnmock('@ai-sdk/openai');
  vi.doUnmock('@ai-sdk/anthropic');
  vi.doUnmock('ollama-ai-provider');
  vi.doUnmock('ollama-ai-provider-v2');
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

// The hint names the provider package version that pairs with the installed `ai` (LOU-D28d).
const AI_SDK_RANGE = ({ 4: '^0.0.42', 6: '^3.0.0', 7: '^4.0.0' } as Record<number, string>)[installedAiMajor];
const OLLAMA_PEER = installedAiMajor === 4 ? 'ollama-ai-provider@^1.2.0' : `ollama-ai-provider-v2@^${installedAiMajor === 6 ? 3 : 4}.0.0`;

const CASES: Case[] = [
  {
    label: 'OpenAIProvider',
    packageName: '@ai-sdk/openai',
    installCommand: `npm install @ai-sdk/openai@${AI_SDK_RANGE}`,
    load: async () => new (await import('./OpenAIProvider')).OpenAIProvider({ name: 'openai', apiKey: 'k' }),
  },
  {
    label: 'OpenRouterProvider',
    packageName: '@ai-sdk/openai',
    installCommand: `npm install @ai-sdk/openai@${AI_SDK_RANGE}`,
    load: async () => new (await import('./OpenRouterProvider')).OpenRouterProvider({ name: 'openrouter', apiKey: 'k' }),
  },
  {
    label: 'AnthropicProvider',
    packageName: '@ai-sdk/anthropic',
    installCommand: `npm install @ai-sdk/anthropic@${AI_SDK_RANGE}`,
    load: async () => new (await import('./AnthropicProvider')).AnthropicProvider({ name: 'anthropic', apiKey: 'k' }),
  },
  {
    label: 'OllamaProvider',
    packageName: OLLAMA_PEER.slice(0, OLLAMA_PEER.lastIndexOf('@')),
    installCommand: `npm install ${OLLAMA_PEER}`,
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
    expect(error).toMatchObject({ packageName, installCommand, code: 'LOUSHO_PEER_MISSING' });
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
      installCommand: 'npm install dockerode@^5.0.1',
    });
  });
});

describe('feature peers (LOU-D40)', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

  it.each(Object.entries(FEATURE_PEERS))('%s is an optional peer whose range matches package.json', (name, peer) => {
    expect(manifest.peerDependencies[name]).toBe(peer.range);
    expect(manifest.peerDependenciesMeta[name]).toEqual({ optional: true });
    expect(manifest.devDependencies[name]).toBe(peer.range); // the repo's own tests still run
    expect(manifest.dependencies?.[name]).toBeUndefined();
  });

  it.each([
    ['dockerode', 'Docker sandboxing', 'npm install dockerode@^5.0.1'],
    ['@modelcontextprotocol/sdk', 'MCP', 'npm install @modelcontextprotocol/sdk@^1.30.1'],
    ['prompts', '`lousho init`', 'npm install prompts@^2.4.2'],
  ])('the error for %s names the feature and the exact install command', async (name, feature, command) => {
    const error = await loadOptionalPeer(name, () => Promise.reject(moduleNotFound(name))).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MissingPeerDependencyError);
    expect(error).toMatchObject({ packageName: name, installCommand: command });
    expect((error as MissingPeerDependencyError).feature).toContain(feature);
    expect((error as Error).message).toContain(feature);
    expect((error as Error).message).toContain(`Run: ${command}`);
  });

  it('buildServer() rejects with the MCP install hint when the MCP SDK is missing', async () => {
    vi.resetModules();
    vi.doMock('@modelcontextprotocol/sdk/server/mcp.js', () => {
      throw moduleNotFound('@modelcontextprotocol/sdk/server/mcp.js');
    });
    const { buildServer } = await import('../tools/mcp/server/buildServer');
    await expect(buildServer({ name: 'x', version: '1', tools: [] } as never)).rejects.toMatchObject({
      name: 'MissingPeerDependencyError',
      installCommand: 'npm install @modelcontextprotocol/sdk@^1.30.1',
    });
    vi.doUnmock('@modelcontextprotocol/sdk/server/mcp.js');
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
