/**
 * M3b: an agent directory as bundled into a Cloudflare Worker (WorkerAgentDir)
 * becomes createAgent() options with resolveAgentDir()'s rules, and the Worker
 * runtime serves it. In-process, mock providers only.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { defineTool } from '../tools/defineTool';
import { createMockProvider } from '../providers/mock';
import { resolveWorkerAgentDir, type WorkerAgentDir } from './workerAgentDir';
import { handleWorkerAgentDirRequest, prepareWorkerAgentDir, workerAgentFromDir } from './runtime.worker';

const echo = defineTool({
  name: 'echo',
  description: 'Echoes its input back',
  input: z.object({ input: z.string() }),
  execute: ({ input }) => `echo: ${input}`,
});

function dir(overrides: Partial<WorkerAgentDir> = {}): WorkerAgentDir {
  return {
    name: 'my-agent',
    instructions: 'Be brief.',
    configFile: 'agent.json',
    config: { model: 'mock/test' },
    toolModules: [{ file: 'tools/echo.ts', module: { default: echo } }],
    skills: [],
    ...overrides,
  };
}

describe('resolveWorkerAgentDir (M3b)', () => {
  it('assembles name, instructions, the provider type and model, tools and settings', () => {
    const resolved = resolveWorkerAgentDir(
      dir({ config: { name: 'renamed', model: 'OpenAI/gpt-4o-mini', maxSteps: 3, toolConcurrency: 2 } })
    );
    expect(resolved).toMatchObject({
      name: 'renamed',
      instructions: 'Be brief.',
      model: { providerType: 'openai', model: 'gpt-4o-mini' },
      maxSteps: 3,
      toolConcurrency: 2,
    });
    expect(resolved.tools).toEqual([echo]);
  });

  it("takes an agent.ts config module's default export, and its provider instance", () => {
    const provider = createMockProvider({ name: 'mock', responses: ['hi'] });
    const resolved = resolveWorkerAgentDir(
      dir({ configFile: 'agent.ts', config: undefined, configModule: { default: { provider, model: 'mock-2', instructions: undefined } }, instructions: 'x' })
    );
    expect(resolved.model).toEqual({ provider, model: 'mock-2' });
    expect(resolved.name).toBe('my-agent');
  });

  it("drops a 'provider/model' string next to a provider instance, as resolveAgentDir() does", () => {
    const provider = createMockProvider();
    expect(resolveWorkerAgentDir(dir({ config: undefined, configFile: 'agent.ts', configModule: { provider, model: 'openai/gpt-4o' } })).model).toEqual({ provider });
  });

  it('takes instructions from the config when there is no instructions.md', () => {
    expect(resolveWorkerAgentDir(dir({ instructions: undefined, config: { model: 'mock/x', instructions: 'From config.' } })).instructions).toBe('From config.');
  });

  it('collects every tool export with the loadTools() rules', () => {
    const other = defineTool({ name: 'other', description: 'Other', input: z.object({}), execute: () => 'ok' });
    const resolved = resolveWorkerAgentDir(dir({ toolModules: [{ file: 'tools/a.ts', module: { default: echo, list: [other] } }] }));
    expect(resolved.tools.map((t) => t.name)).toEqual(['echo', 'other']);
  });

  it.each([
    [{ toolModules: [{ file: 'tools/a.ts', module: { default: echo } }, { file: 'tools/b.ts', module: { echo } }] }, "duplicate tool name 'echo' in tools/a.ts and tools/b.ts", 'LOUSHO_AGENT_DIR_INVALID'],
    [{ toolModules: [{ file: 'tools/a.ts', module: { helper: 1 } }] }, 'tools/a.ts: it exports { helper: number }', 'LOUSHO_AGENT_DIR_INVALID'],
    [{ config: { model: 'mock/x', instructions: 'twice' } }, 'instructions are given twice', 'LOUSHO_AGENT_DIR_INVALID'],
    [{ instructions: undefined }, 'my-agent has no instructions', 'LOUSHO_AGENT_DIR_INVALID'],
    [{ config: { model: 'mock/x', modle: 'y' } }, "unknown config key 'modle' (did you mean 'model'?)", 'LOUSHO_AGENT_DIR_INVALID'],
    [{ config: { model: 'gpt-4o' } }, "'model' must be a 'provider/model' string", 'LOUSHO_DEPLOY_FAILED'],
    [{ config: { model: 'ollama/llama3' } }, "uses provider 'ollama'", 'LOUSHO_DEPLOY_FAILED'],
    [{ config: {} }, 'agent.json sets no model', 'LOUSHO_DEPLOY_FAILED'],
    [{ configFile: undefined, config: undefined }, "the agent directory 'my-agent' sets no model", 'LOUSHO_DEPLOY_FAILED'],
    [{ config: { model: 'mock/x', projectInstructions: true } }, "agent.json sets 'projectInstructions'", 'LOUSHO_DEPLOY_FAILED'],
  ] as Array<[Partial<WorkerAgentDir>, string, string]>)('refuses %j', (overrides, message, code) => {
    expect(() => resolveWorkerAgentDir(dir(overrides))).toThrow(expect.objectContaining({ code, message: expect.stringContaining(message) }));
  });
});

describe('the Worker runtime of an agent directory (M3b)', () => {
  it('prepareWorkerAgentDir caches the resolved options per directory', () => {
    const agentDir = dir();
    expect(prepareWorkerAgentDir(agentDir)).toBe(prepareWorkerAgentDir(agentDir));
  });

  it('workerAgentFromDir runs a turn with the provider instance of an agent.ts config', async () => {
    const provider = createMockProvider({ name: 'mock', responses: ['from agent.ts'] });
    const agent = workerAgentFromDir(dir({ config: undefined, configFile: 'agent.ts', configModule: { default: { provider } }, toolModules: [] }), {});
    expect((await agent.send('hi')).text).toBe('from agent.ts');
  });

  it('handleWorkerAgentDirRequest serves /chat with the directory tools and skills', async () => {
    const agentDir = dir({ skills: [{ name: 'notes', description: 'Release notes', content: '# Notes' }], config: { model: 'mock/test', maxSteps: 3, toolConcurrency: 1 } });
    const response = await handleWorkerAgentDirRequest(
      new Request('http://worker/chat', { method: 'POST', body: JSON.stringify({ message: 'echo it' }) }),
      {},
      agentDir
    );
    const result = (await response.json()) as { toolCalls: Array<{ function: { name: string } }>; messages: Array<{ role: string; content: unknown }> };
    expect(result.toolCalls.map((c) => c.function.name)).toEqual(['echo']);
    expect(JSON.stringify(result.messages[0].content)).toContain('- notes: Release notes');
  });
});
