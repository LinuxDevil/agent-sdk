/**
 * M3b: an agent directory as bundled into a Cloudflare Worker (WorkerAgentDir)
 * becomes createAgent() options with resolveAgentDir()'s rules, and the Worker
 * runtime serves it. In-process, mock providers only.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { defineTool } from '../tools/defineTool';
import { createMockProvider } from '../providers/mock';
import { defineSchedule } from '../schedules/defineSchedule';
import { httpChannel } from '../channels/httpChannel';
import { defineMemory } from '../memory/defineMemory';
import { inMemoryMemory } from '../memory/providers';
import { kvMemory } from './workerMemory';
import { resolveWorkerAgentDir, type WorkerAgentDir } from './workerAgentDir';
import { handleWorkerAgentDirRequest, handleWorkerAgentDirScheduled, prepareWorkerAgentDir, workerAgentFromDir, workerStore } from './runtime.worker';

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

  it("carries approvalTtlMs and a permission rule's ttlMs over to the resolved options", () => {
    const resolved = resolveWorkerAgentDir(
      dir({ config: { model: 'mock/x', approvalTtlMs: 60_000, permissions: [{ tool: 'deploy', action: 'ask', ttlMs: 30_000 }] } })
    );
    expect(resolved.approvalTtlMs).toBe(60_000);
    expect(resolved.permissions).toEqual([{ tool: 'deploy', action: 'ask', ttlMs: 30_000 }]);
  });

  it('carries modelSettings over to the resolved options (C6)', () => {
    const resolved = resolveWorkerAgentDir(dir({ config: { model: 'mock/x', modelSettings: { maxTokens: 512, stop: ['END'] } } }));
    expect(resolved.modelSettings).toEqual({ maxTokens: 512, stop: ['END'] });
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
    [{ config: { model: 'mock/x', store: { dir: './.lousho' } } }, "'store' declares a file store", 'LOUSHO_DEPLOY_FAILED'],
  ] as Array<[Partial<WorkerAgentDir>, string, string]>)('refuses %j', (overrides, message, code) => {
    expect(() => resolveWorkerAgentDir(dir(overrides))).toThrow(expect.objectContaining({ code, message: expect.stringContaining(message) }));
  });
});

describe('resolveWorkerAgentDir: schedules, channels, memory (#298)', () => {
  const morning = defineSchedule({ cron: '0 9 * * MON', prompt: 'Good morning' });

  it('collects the scheduleModules schedules, naming them after the file stem', () => {
    const resolved = resolveWorkerAgentDir(
      dir({
        scheduleModules: [
          { file: 'schedules/report.ts', module: { default: morning } },
          { file: 'schedules/named.ts', module: { default: defineSchedule({ name: 'own', cron: '0 8 * * *', prompt: 'Hi' }) } },
        ],
      })
    );
    expect(resolved.schedules.map((s) => s.name)).toEqual(['report', 'own']);
    expect(resolved.schedules[0].cron).toBe('0 9 * * MON');
  });

  it('rejects a schedule file whose default export is not a defineSchedule() schedule', () => {
    expect(() => resolveWorkerAgentDir(dir({ scheduleModules: [{ file: 'schedules/bad.ts', module: { default: { cron: '0 9 * * *' } } }] }))).toThrow(
      expect.objectContaining({ code: 'LOUSHO_SCHEDULE_INVALID', message: expect.stringContaining('schedules/bad.ts') })
    );
  });

  it('collects the channelModules channels, naming them after the file stem when the export sets no name', () => {
    const resolved = resolveWorkerAgentDir(dir({ channelModules: [{ file: 'channels/api.ts', module: { default: httpChannel() } }] }));
    expect(resolved.channels.map((c) => c.name)).toEqual(['http']);
    const unnamed = resolveWorkerAgentDir(
      dir({ channelModules: [{ file: 'channels/hook.ts', module: { default: { parse: async () => null, reply: async () => undefined } } }] })
    );
    expect(unnamed.channels.map((c) => c.name)).toEqual(['hook']);
  });

  it('rejects a channel file whose default export is not a channel', () => {
    expect(() => resolveWorkerAgentDir(dir({ channelModules: [{ file: 'channels/bad.ts', module: { default: { nope: 1 } } }] }))).toThrow(
      expect.objectContaining({ code: 'LOUSHO_CHANNEL_INVALID', message: expect.stringContaining('channels/bad.ts') })
    );
  });

  it('collects the memoryModules slots, naming them after the file stem', () => {
    const resolved = resolveWorkerAgentDir(
      dir({ memoryModules: [{ file: 'memory/notes.ts', module: { default: defineMemory({ name: 'notes', scope: 'global', provider: inMemoryMemory() }) } }] })
    );
    expect(resolved.memory.map((m) => m.name)).toEqual(['notes']);
    const unnamed = resolveWorkerAgentDir(
      dir({ memoryModules: [{ file: 'memory/prefs.ts', module: { default: { scope: 'global', provider: inMemoryMemory() } } }] })
    );
    expect(unnamed.memory.map((m) => m.name)).toEqual(['prefs']);
  });

  it('rejects a memory file whose default export is not a memory slot', () => {
    expect(() => resolveWorkerAgentDir(dir({ memoryModules: [{ file: 'memory/bad.ts', module: { default: 42 } }] }))).toThrow(
      expect.objectContaining({ code: 'LOUSHO_MEMORY_INVALID', message: expect.stringContaining('memory/bad.ts') })
    );
  });
});

describe('resolveWorkerAgentDir: subagents (#298)', () => {
  const child = (overrides: Partial<WorkerAgentDir> = {}): WorkerAgentDir =>
    dir({
      name: 'reviewer',
      instructions: 'Review code.',
      config: { description: 'Reviews pull requests' },
      toolModules: [],
      ...overrides,
    });

  it('resolves each sub-agent with its description, tools and the parent model it inherits', () => {
    const resolved = resolveWorkerAgentDir(dir({ subagents: [{ name: 'reviewer', dir: child() }] }));
    expect(resolved.subagents).toEqual([
      expect.objectContaining({
        name: 'reviewer',
        description: 'Reviews pull requests',
        dir: expect.objectContaining({ name: 'reviewer', instructions: 'Review code.', model: { providerType: 'mock', model: 'test' } }),
      }),
    ]);
  });

  it('lets a sub-agent choose its own model and keeps its own tools', () => {
    const resolved = resolveWorkerAgentDir(
      dir({ subagents: [{ name: 'reviewer', dir: child({ config: { description: 'Reviews', model: 'openai/gpt-4o' }, toolModules: [{ file: 'tools/e.ts', module: { default: echo } }] }) }] })
    );
    expect(resolved.subagents[0].dir.model).toEqual({ providerType: 'openai', model: 'gpt-4o' });
    expect(resolved.subagents[0].dir.tools).toEqual([echo]);
  });

  it('resolves sub-agents recursively', () => {
    const resolved = resolveWorkerAgentDir(dir({ subagents: [{ name: 'reviewer', dir: child({ subagents: [{ name: 'inner', dir: child({ name: 'inner' }) }] }) }] }));
    expect(resolved.subagents[0].dir.subagents.map((s) => s.name)).toEqual(['inner']);
  });

  it('requires a description on a sub-agent', () => {
    expect(() => resolveWorkerAgentDir(dir({ subagents: [{ name: 'reviewer', dir: child({ config: {} }) }] }))).toThrow(
      expect.objectContaining({ code: 'LOUSHO_AGENT_DIR_INVALID', message: expect.stringContaining("'description'") })
    );
  });
});

describe('resolveWorkerAgentDir: projectInstructions (#298)', () => {
  it('appends the embedded AGENTS.md / CLAUDE.md block when the config asks for it', () => {
    const resolved = resolveWorkerAgentDir(
      dir({ config: { model: 'mock/x', projectInstructions: true }, projectInstructions: { file: 'AGENTS.md', content: 'Follow the rules.' } })
    );
    expect(resolved.instructions).toBe('Be brief.\n\n## Project instructions (from AGENTS.md)\n\nFollow the rules.');
  });

  it('adds nothing when no file was embedded, as loadProjectInstructions() would', () => {
    const resolved = resolveWorkerAgentDir(dir({ config: { model: 'mock/x', projectInstructions: true } }));
    expect(resolved.instructions).toBe('Be brief.');
  });

  it('refuses an options object a code config kept from the build', () => {
    expect(() =>
      resolveWorkerAgentDir(
        dir({
          config: undefined,
          configFile: 'agent.ts',
          configModule: { default: { provider: createMockProvider(), projectInstructions: { files: ['CLAUDE.md'] } } },
          projectInstructions: { file: 'AGENTS.md', content: 'x' },
        })
      )
    ).toThrow(expect.objectContaining({ code: 'LOUSHO_DEPLOY_FAILED', message: expect.stringContaining("'projectInstructions'") }));
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

describe('the Worker runtime of an agent directory: subagents, channels, memory, schedules (#298)', () => {
  const chat = (agentDir: WorkerAgentDir, body: unknown, env: Record<string, unknown> = {}) =>
    handleWorkerAgentDirRequest(new Request('http://worker/chat', { method: 'POST', body: JSON.stringify(body) }), env, agentDir);

  it('adds a delegate_to_<name> tool per sub-agent, which runs the sub-agent with the inherited model', async () => {
    const agentDir = dir({
      subagents: [
        {
          name: 'reviewer',
          dir: dir({ name: 'reviewer', instructions: 'You review.', config: { description: 'Reviews things' }, toolModules: [] }),
        },
      ],
    });
    const response = await chat(agentDir, { message: 'please use delegate_to_reviewer' });
    const result = (await response.json()) as { toolCalls: Array<{ function: { name: string } }> };
    expect(result.toolCalls.map((c) => c.function.name)).toEqual(['delegate_to_reviewer']);
  });

  it('serves a directory channel under /channels without the API token', async () => {
    const agentDir = dir({ channelModules: [{ file: 'channels/api.ts', module: { default: httpChannel({ name: 'api' }) } }] });
    const response = await handleWorkerAgentDirRequest(
      new Request('http://worker/channels/api', { method: 'POST', body: JSON.stringify({ sessionKey: 'u1', input: 'hi' }) }),
      { LOUSHO_API_TOKEN: 'tok' },
      agentDir
    );
    expect(response.status).toBe(200);
    const result = (await response.json()) as { sessionId: string; text: string };
    expect(result.sessionId).toMatch(/^api_u1-/);
    expect(result.text).toBe('This is a mock response.');
    // The channel route does not shadow the chat API.
    const chatResponse = await chat(agentDir, { message: 'hi' }, { LOUSHO_API_TOKEN: 'tok' });
    expect(chatResponse.status).toBe(401);
  });

  it('binds a kvMemory() provider to the KV namespace on env', async () => {
    const kv = new Map<string, string>();
    const binding = {
      get: async (key: string) => kv.get(key) ?? null,
      put: async (key: string, value: string) => void kv.set(key, value),
      delete: async (key: string) => void kv.delete(key),
    };
    kv.set('memory/notes#global', JSON.stringify([{ id: '1', text: 'likes tea', createdAt: '2024-01-01T00:00:00.000Z' }]));
    const agentDir = dir({
      memoryModules: [
        { file: 'memory/notes.ts', module: { default: defineMemory({ name: 'notes', scope: 'global', provider: kvMemory() }) } },
      ],
    });
    const response = await chat(agentDir, { message: 'please use recall_notes' }, { AGENT_CHECKPOINTS: binding });
    const result = (await response.json()) as { toolCalls: Array<{ function: { name: string } }>; messages: Array<{ role: string; content: unknown }> };
    expect(result.toolCalls.map((c) => c.function.name)).toContain('recall_notes');
    const toolMessage = result.messages.find((m) => m.role === 'tool');
    expect(JSON.stringify(toolMessage?.content)).toContain('likes tea');
  });

  it('runs a schedule from handleWorkerAgentDirScheduled inside ctx.waitUntil', async () => {
    const agentDir = dir({
      scheduleModules: [{ file: 'schedules/report.ts', module: { default: defineSchedule({ cron: '0 9 * * MON', prompt: 'Report.' }) } }],
    });
    const waited: Promise<unknown>[] = [];
    await handleWorkerAgentDirScheduled({ cron: '0 9 * * MON' }, {}, { waitUntil: (p) => waited.push(p) }, agentDir);
    expect(waited).toHaveLength(1);
    await waited[0];
    // A prompt schedule runs a turn under session `schedule-<name>` in the Worker's store.
    const checkpoint = await workerStore({}).checkpoints?.load('schedule-report');
    expect(JSON.stringify(checkpoint)).toContain('Report.');
    // A cron that matches nothing runs nothing.
    await handleWorkerAgentDirScheduled({ cron: '0 10 * * MON' }, {}, { waitUntil: (p) => waited.push(p) }, agentDir);
    expect(waited).toHaveLength(2); // still resolves and registers its (empty) waitUntil
  });
});
