import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NodeServerAdapter, providersInSource } from './node-server';

describe('providersInSource', () => {
  it('finds literal model prefixes and SDK provider classes', () => {
    expect(providersInSource("createAgent({ model: 'anthropic/claude-sonnet-4-5' })")).toEqual(['anthropic']);
    expect(providersInSource("import { OpenRouterProvider } from '@lousho/build-ai-agent';\nnew OpenRouterProvider({ apiKey })")).toEqual(['openrouter']);
    expect(providersInSource('new OpenAIProvider({}); new OllamaProvider({})').sort()).toEqual(['ollama', 'openai']);
    expect(providersInSource('const x = 1')).toEqual([]);
  });
});

describe('node-server scaffold of an agent module with a provider instance', () => {
  let root: string | undefined;
  afterEach(() => {
    vi.restoreAllMocks();
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  async function scaffoldDependencies(source: string): Promise<Record<string, string>> {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-providers-'));
    const file = path.join(root, 'agent.ts');
    fs.writeFileSync(file, source);
    const outDir = path.join(root, 'out');
    await NodeServerAdapter.scaffold(file, outDir);
    return JSON.parse(fs.readFileSync(path.join(outDir, 'package.json'), 'utf8')).dependencies;
  }

  it('lists the provider package for new OpenRouterProvider(...)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const deps = await scaffoldDependencies("export default { provider: new OpenRouterProvider({ apiKey: 'k' }) };");
    expect(Object.keys(deps)).toEqual(['@ai-sdk/openai']);
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns, naming how to add the dependency, when no provider is detected', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const deps = await scaffoldDependencies('export default { provider: makeProvider() };');
    expect(deps).toEqual({});
    expect(warn.mock.calls[0][0]).toMatch(/add it to the "dependencies" of the generated package\.json/);
  });
});
