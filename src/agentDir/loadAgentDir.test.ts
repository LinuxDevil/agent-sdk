import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseStep } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { loadAgentDir, resolveAgentDir } from './index';
import { defineTool } from '../tools/defineTool';
import { memoryStore } from '../storage/agentStore';
import { mockModel } from '../testing';
import { isRemoteSubagent } from '../subagents/remoteAgent';
import { explainImportError } from './importModule';
import { closest } from './closest';
import { SDKError } from '../utils/sdkError';
import type { CreateAgentBase } from '../createAgent';
import type { IoGuardrail } from '../execution/ioGuardrails';

const fixture = (name: string): string => path.join(__dirname, '__fixtures__', name);
const systemOf = (call: { messages: readonly { role: string; content: unknown }[] }): string =>
  String(call.messages.find((m) => m.role === 'system')?.content);
const toolMessages = (call: { messages: readonly { role: string; content: unknown }[] }): string[] =>
  call.messages.filter((m) => m.role === 'tool').map((m) => String(m.content));

describe('resolveAgentDir', () => {
  it('discovers every layout: ts config, ts tools (default + named), skills (both layouts), subagents', async () => {
    const { config, manifest } = await resolveAgentDir(fixture('full'), { provider: mockModel(['x']) });

    expect(manifest.name).toBe('full');
    expect(manifest.description).toBe('Fixture agent covering every layout');
    expect(manifest.tools).toEqual(['echo', 'add', 'double']);
    expect(manifest.skills).toEqual(['changelog', 'release']);
    expect(manifest.subagents).toEqual(['researcher']);
    expect(manifest.files.map((f) => path.relative(fixture('full'), f).split(path.sep).join('/'))).toEqual([
      'agent.ts',
      'instructions.md',
      'tools/a_echo.ts',
      'tools/b_math.ts',
    ]);
    expect(config.instructions).toBe('You are the fixture agent. Use your tools and skills.');
    expect(config.maxSteps).toBe(4);
    expect(config.toolConcurrency).toBe(1);
    expect(Array.isArray(config.tools) && config.tools.map((t) => t.name)).toEqual([
      'echo',
      'add',
      'double',
      'delegate_to_researcher',
    ]);
  });

  it('loads .js tools with a .json config', async () => {
    const { config, manifest } = await resolveAgentDir(fixture('js-json'), { provider: mockModel(['x']) });
    expect(manifest.tools).toEqual(['ping']);
    expect(config.name).toBe('js-json-agent');
    expect(config.maxSteps).toBe(3);
  });

  it('loads a .yaml config with inline instructions and no other files', async () => {
    const { config, manifest } = await resolveAgentDir(fixture('yaml-inline'));
    expect(config.instructions).toBe('You are the YAML fixture agent.');
    expect(config.maxSteps).toBe(2);
    expect(config.tools).toBeUndefined();
    expect(config.skills).toBeUndefined();
    expect(manifest).toMatchObject({ tools: [], skills: [], subagents: [] });
    expect(manifest.files).toHaveLength(1);
  });

  it('lets overrides win over files', async () => {
    const provider = mockModel(['x']);
    const { config } = await resolveAgentDir(fixture('js-json'), {
      provider,
      name: 'renamed',
      instructions: 'override prompt',
      maxSteps: 9,
    });
    expect(config).toMatchObject({ name: 'renamed', instructions: 'override prompt', maxSteps: 9, provider });
    const viaAlias = await resolveAgentDir(fixture('js-json'), { prompt: 'alias prompt' });
    expect(viaAlias.config.instructions).toBe('alias prompt');
  });

  it('drops a file-level provider/model string when a provider instance is overridden', async () => {
    const provider = mockModel(['x']);
    const tweaked = await resolveAgentDir(fixture('full'), { provider, model: 'bare-model-id' });
    expect(tweaked.config).toMatchObject({ provider, model: 'bare-model-id' });
  });

  it('replaces discovered tools and skills when overridden, without reading them', async () => {
    const mine = defineTool({ name: 'mine', description: 'd', input: z.object({}), execute: () => 1 });
    const { config } = await resolveAgentDir(fixture('full'), {
      provider: mockModel(['x']),
      tools: [mine],
      skills: [],
    });
    expect(config.tools).toEqual([mine]);
    expect(config.skills).toEqual([]);
  });

  it('rejects a path that is not a directory', async () => {
    await expect(resolveAgentDir(path.join(fixture('full'), 'instructions.md'))).rejects.toThrow(
      /is not a directory/
    );
  });
});

/**
 * F2 (audit A3): every `createAgent()` option, so a new one cannot be added
 * without this test noticing. `satisfies` fails to compile on a missing or an
 * unknown key.
 */
const CREATE_AGENT_OPTIONS = {
  tools: true, mcpServers: true, skills: true, name: true, description: true, subagents: true, subagentOptions: true,
  handoffs: true, maxHandoffs: true, toolSearch: true, codeMode: true, maxSubagentDepth: true, maxSteps: true, limits: true,
  guardrails: true, toolConcurrency: true, onAgentDrift: true, reasoning: true, onEvent: true, exporter: true,
  captureContent: true, redactContent: true, projectInstructions: true, store: true, approvalStore: true, approve: true,
  approvalTtlMs: true, askQuestion: true, retry: true, fallbackModels: true, output: true, hooks: true, compaction: true,
  memory: true, permissions: true, onPermissionDecision: true, permissionMode: true, onPermissionModeChange: true,
} satisfies Record<keyof CreateAgentBase, true>;

describe('createAgent() overrides', () => {
  it('forwards every createAgent() option to the assembled config', async () => {
    const keys = Object.keys(CREATE_AGENT_OPTIONS) as (keyof CreateAgentBase)[];
    // A distinct value per option (an array, since `skills` and `memory` are copied, not passed by reference).
    const overrides = Object.fromEntries(keys.map((key) => [key, [{ name: `override-${key}` }]]));
    const { config } = await resolveAgentDir(fixture('js-json'), { provider: mockModel(['x']), ...overrides } as never);

    const assembled = config as unknown as Record<string, unknown>;
    const dropped = keys.filter((key) => JSON.stringify(assembled[key]) !== JSON.stringify(overrides[key]));
    expect(dropped).toEqual([]);
  });

  it('runs the agent with an onEvent and guardrails override (they were dropped before)', async () => {
    const events: string[] = [];
    const blockPing: IoGuardrail = { name: 'block-ping', check: ({ toolName }) => (toolName === 'ping' ? { ok: false, reason: 'no ping' } : { ok: true }) };
    const model = mockModel([{ toolCalls: [{ name: 'ping', args: {} }] }, 'done']);
    const agent = await loadAgentDir(fixture('js-json'), { provider: model, onEvent: (event) => events.push(event.type), guardrails: { tools: [blockPing] } });

    await agent.send('go').catch(() => undefined);

    expect(events).toContain('guardrail.tripped');
    expect(events).not.toContain('tool.done');
  });
});

describe('loadAgentDir', () => {
  it('returns a working createAgent() agent whose disk tools and skills are callable', async () => {
    const model = mockModel([
      {
        toolCalls: [
          { name: 'echo', args: { text: 'hi' } },
          { name: 'add', args: { a: 2, b: 3 } },
          { name: 'load_skill', args: { name: 'release' } },
        ],
      },
      'All done.',
    ]);
    const agent = await loadAgentDir(fixture('full'), { provider: model });

    const result = await agent.send('go');

    expect(result.text).toBe('All done.');
    const first = model.calls[0];
    expect(systemOf(first)).toContain('You are the fixture agent.');
    expect(systemOf(first)).toContain('- changelog: How to write a changelog entry');
    expect(systemOf(first)).not.toContain('Bump the version');
    expect(first.tools?.map((t) => t.function.name).sort()).toEqual([
      'add',
      'delegate_to_researcher',
      'double',
      'echo',
      'load_skill',
    ]);
    const outputs = toolMessages(model.calls[1]).join('\n');
    expect(outputs).toContain('echo: hi');
    expect(outputs).toContain('5');
    expect(outputs).toContain('Bump the version');
  });

  it('runs a .js tool', async () => {
    const model = mockModel([{ toolCalls: [{ name: 'ping' }] }, 'ok']);
    const agent = await loadAgentDir(fixture('js-json'), { provider: model });
    await agent.send('ping it');
    expect(toolMessages(model.calls[1]).join('')).toContain('pong');
  });

  it('delegates to a sub-agent directory, which uses its own tools and inherits the provider override', async () => {
    const model = mockModel([
      { toolCalls: [{ name: 'delegate_to_researcher', args: { task: 'find cats' } }] },
      { toolCalls: [{ name: 'lookup', args: { topic: 'cats' } }] },
      'Cats are great.',
      'The researcher says cats are great.',
    ]);
    const agent = await loadAgentDir(fixture('full'), { provider: model });

    const result = await agent.send('research cats');

    expect(result.text).toBe('The researcher says cats are great.');
    const parentTool = model.calls[0].tools?.find((t) => t.function.name === 'delegate_to_researcher');
    expect(parentTool?.function.description).toContain('Looks facts up');
    expect(systemOf(model.calls[1])).toContain('You are the researcher.');
    expect(toolMessages(model.calls[2]).join('')).toContain('fact about cats');
    expect(toolMessages(model.calls[3]).join('')).toContain('Cats are great.');
  });
});

describe('agent.* run options (permissionMode, permissions, compaction, hooks, approve, limits)', () => {
  it('maps every new key into the createAgent() options and tracks the files it imported', async () => {
    const { config, manifest } = await resolveAgentDir(fixture('config-extras'), {
      provider: mockModel(['x']),
      model: 'openrouter/openai/gpt-4o-mini',
    });

    expect(config.permissionMode).toBe('default');
    expect(config.compaction).toEqual({ thresholdPercent: 0.8 });
    expect(config.limits).toEqual({ maxCostUsd: 0.05, onExceeded: 'stop' });
    expect(config.permissions).toHaveLength(3);
    expect(config.permissions?.[0]).toMatchObject({ tool: 'shell', action: 'deny', reason: 'No deletes' });
    expect(typeof config.approve).toBe('function');
    expect(config.hooks?.map((hook) => hook.name)).toEqual(['spy']);
    const files = manifest.files.map((f) => path.relative(fixture('config-extras'), f).split(path.sep).join('/'));
    expect(files).toEqual(
      expect.arrayContaining(['agent.json', 'instructions.md', 'instructions/openai.md', 'hooks.ts', 'approve.ts', 'tools/stubs.ts'])
    );
  });

  it('appends instructions/<family>.md whose stem is in the model id, once', async () => {
    const openai = await resolveAgentDir(fixture('config-extras'), { provider: mockModel(['x']), model: 'openrouter/openai/gpt-4o-mini' });
    expect(openai.config.instructions).toBe('You are the extras fixture agent.\nCall one tool at a time.');
    const anthropic = await resolveAgentDir(fixture('config-extras'), { model: 'anthropic/claude-haiku-4-5' });
    expect(anthropic.config.instructions).toBe('You are the extras fixture agent.\nPrefer edit_file over write_file.');
    const other = await resolveAgentDir(fixture('config-extras'), { model: 'ollama/llama3.1' });
    expect(other.config.instructions).toBe('You are the extras fixture agent.');
  });

  it('runs the directory: a `when` record denies rm, the approver refuses test files, hooks observe calls', async () => {
    const { seen } = (await import(pathToFileURL(path.join(fixture('config-extras'), 'hooks.ts')).href)) as { seen: string[] };
    seen.length = 0;
    const model = mockModel([
      { toolCalls: [{ name: 'shell', args: { command: 'rm -rf node_modules' } }] },
      { toolCalls: [{ name: 'write_file', args: { path: 'math.test.js' } }] },
      { toolCalls: [{ name: 'write_file', args: { path: 'math.js' } }] },
      'Done.',
    ]);
    const agent = await loadAgentDir(fixture('config-extras'), { provider: model });

    const result = await agent.send('go');

    expect(result.text).toBe('Done.');
    const outputs = toolMessages(model.calls[model.calls.length - 1]).join('\n');
    expect(outputs).toContain('No deletes');
    expect(outputs).not.toContain('wrote math.test.js');
    expect(outputs).toContain('wrote math.js');
    // preToolCall ran for every call (hooks come before permission rules); an
    // approved call can be re-prepared after its pause, hence >= not =.
    expect(seen[0]).toBe('shell');
    expect(seen.filter((name) => name === 'write_file').length).toBeGreaterThanOrEqual(2);
  });

  it('lets overrides replace the configured hooks and approver without reading their files', async () => {
    const approve = () => true;
    const { config } = await resolveAgentDir(fixture('err-missing-hooks'), {
      provider: mockModel(['x']),
      hooks: [],
      approve,
    });
    expect(config.hooks).toEqual([]);
    expect(config.approve).toBe(approve);
  });

  it('approve: null / hooks: null strip the directory-wired approver and hooks (the files are not even imported)', async () => {
    const { config, manifest } = await resolveAgentDir(fixture('config-extras'), {
      provider: mockModel(['x']),
      approve: null,
      hooks: null,
    });
    expect(config.approve).toBeUndefined();
    expect(config.hooks).toBeUndefined();
    const files = manifest.files.map((f) => path.relative(fixture('config-extras'), f).split(path.sep).join('/'));
    expect(files).not.toContain('approve.ts');
    expect(files).not.toContain('hooks.ts');
  });
});

describe('agent.* store and approval TTL (store, approvalTtlMs, ttlMs)', () => {
  /** A minimal agent directory in a temp dir (a fixture would litter its own .lousho/). */
  const writeDir = (config: Record<string, unknown>): string => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lousho-agentdir-store-'));
    writeFileSync(path.join(dir, 'agent.json'), JSON.stringify(config));
    writeFileSync(path.join(dir, 'instructions.md'), 'You are a test agent.\n');
    return dir;
  };

  const charge = defineTool({
    name: 'charge',
    description: 'Charge a card',
    input: z.object({ amount: z.number() }),
    execute: ({ amount }) => `charged ${amount}`,
  });

  it('builds a fileStore from "store": { "dir" }, rooted inside the agent directory', async () => {
    const dir = writeDir({ model: 'mock/m', store: { dir: './.lousho' } });
    try {
      const { config } = await resolveAgentDir(dir, { provider: mockModel(['x']) });
      expect(config.store?.sessions).toBeDefined();
      expect(config.store?.checkpoints).toBeDefined();
      expect(config.store?.approvals).toBeDefined();
      await config.store!.sessions!.save('s1', []);
      expect(existsSync(path.join(dir, '.lousho', 'sessions', 's1.json'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a store.dir that escapes the agent directory, naming the key', async () => {
    const dir = writeDir({ model: 'mock/m', store: { dir: '../outside' } });
    try {
      const error = (await resolveAgentDir(dir, { provider: mockModel(['x']) }).catch((e: Error) => e)) as Error;
      expect(error.message).toContain('agent.json');
      expect(error.message).toContain("'store.dir'");
      expect(error.message).toContain('must stay inside the agent directory');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lets an overrides store win over the config one', async () => {
    const dir = writeDir({ model: 'mock/m', store: { dir: './.lousho' } });
    const mine = memoryStore();
    try {
      const { config } = await resolveAgentDir(dir, { provider: mockModel(['x']), store: mine });
      expect(config.store).toBe(mine);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("wires approvalTtlMs and an ask rule's ttlMs into the assembled options", async () => {
    const dir = writeDir({
      model: 'mock/m',
      approvalTtlMs: 600_000,
      permissions: [
        { tool: 'deploy', action: 'ask', ttlMs: 60_000 },
        { tool: 'shell', action: 'deny' },
      ],
    });
    try {
      const { config } = await resolveAgentDir(dir, { provider: mockModel(['x']) });
      expect(config.approvalTtlMs).toBe(600_000);
      expect(config.permissions).toMatchObject([
        { tool: 'deploy', action: 'ask', ttlMs: 60_000 },
        { tool: 'shell', action: 'deny' },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps a paused approval in the declared store so a reloaded agent can resolve it (draft today, approve tomorrow)', async () => {
    const dir = writeDir({
      model: 'mock/m',
      store: { dir: './.lousho' },
      permissions: [{ tool: 'charge', action: 'ask', ttlMs: 600_000 }],
    });
    try {
      const first = await loadAgentDir(dir, {
        provider: mockModel([{ toolCalls: [{ name: 'charge', args: { amount: 5 } }] }, 'Done.']),
        tools: [charge],
      });
      const paused = await first.send('charge 5');
      expect(paused.finishReason).toBe('awaiting-approval');
      expect(paused.approvalId).toBeDefined();

      // The pause is on disk, with the ask rule's ttlMs as its expiresAt.
      const record = JSON.parse(readFileSync(path.join(dir, '.lousho', 'approvals', `${paused.approvalId}.json`), 'utf8'));
      expect(record.pending.toolName).toBe('charge');
      expect(Date.parse(record.pending.expiresAt)).toBeGreaterThan(Date.now());

      // "Approve tomorrow": a fresh load of the same directory decides it.
      const second = await loadAgentDir(dir, { provider: mockModel(['Done.']), tools: [charge] });
      const result = await second.approvals.resolve({ id: paused.approvalId!, approved: true });
      expect(result.text).toBe('Done.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("engine: 'pi' sub-agent directories", () => {
  it('lands a pi sub-agent in the subagents map while a normal one stays a delegate tool', async () => {
    const { config, manifest } = await resolveAgentDir(fixture('pi-subagent'), { provider: mockModel(['x']) });

    expect(manifest.subagents).toEqual(['coder', 'explorer']);
    const toolNames = (config.tools as unknown as { name: string }[]).map((t) => t.name);
    expect(toolNames).toContain('delegate_to_explorer');
    expect(toolNames).not.toContain('delegate_to_coder');

    const coder = (config.subagents as Record<string, unknown>).coder;
    expect(isRemoteSubagent(coder)).toBe(true);
    expect((coder as { name?: string; description: string }).name).toBe('coder');
    expect((coder as { description: string }).description).toBe('Implements code changes with Pi coding tools.');
  });

  it('rejects engine on the main config, a bad engine value and a non-pi model id', async () => {
    const rootError = (await resolveAgentDir(fixture('err-engine-root')).catch((e: Error) => e)) as Error;
    expect(rootError.message).toContain(`'engine' is only valid for a directory under 'subagents/'`);

    const badError = (await resolveAgentDir(fixture('err-engine-bad')).catch((e: Error) => e)) as Error;
    expect(badError.message).toContain(path.join('subagents', 'coder', 'agent.json'));
    expect(badError.message).toContain("'engine' must be 'pi'");

    const modelError = (await resolveAgentDir(fixture('err-engine-model')).catch((e: Error) => e)) as Error;
    expect(modelError.message).toContain("'model' must be a 'pi/<provider>/<model>' id");
  });

  it('delegates through the installed dir: mock lead -> task -> pi session on a faux runtime', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lousho-pidir-'));
    const agentDir = mkdtempSync(path.join(tmpdir(), 'lousho-pidir-pi-'));
    try {
      writeFileSync(path.join(dir, 'agent.json'), JSON.stringify({ model: 'mock/m' }));
      writeFileSync(path.join(dir, 'instructions.md'), 'You delegate code changes to the coder.\n');
      writeFileSync(path.join(dir, 'note.txt'), 'broken\n');
      mkdirSync(path.join(dir, 'subagents', 'coder'), { recursive: true });
      writeFileSync(
        path.join(dir, 'subagents', 'coder', 'agent.json'),
        JSON.stringify({
          description: 'Edits files with Pi tools.',
          engine: 'pi',
          model: 'pi/openrouter/openai/gpt-4o-mini',
          permissions: [
            { tool: 'bash', when: { command: '\\brm\\b' }, action: 'deny', reason: 'No deletes' },
            { tool: '*', action: 'allow' },
          ],
        })
      );

      const runtime = await ModelRuntime.create({
        authPath: path.join(agentDir, 'auth.json'),
        modelsStorePath: path.join(agentDir, 'models.json'),
        refreshOnCreate: false,
      });
      const faux = fauxProvider();
      runtime.registerNativeProvider(faux.provider);
      const piModel = runtime.getModel('faux', 'faux-1')!;
      const fixer: FauxResponseStep = (context) => {
        const last = context.messages.at(-1);
        if (last?.role === 'toolResult') return fauxAssistantMessage('Done.');
        return fauxAssistantMessage(
          fauxToolCall('edit', { path: 'note.txt', edits: [{ oldText: 'broken', newText: 'fixed' }] })
        );
      };
      faux.setResponses([fixer, fixer, fixer]);

      const agent = await loadAgentDir(dir, {
        provider: mockModel([
          { toolCalls: [{ name: 'task', args: { agent: 'coder', prompt: 'Fix note.txt', description: 'fix note' } }] },
          { text: 'delegated' },
        ]),
        piAgent: { modelRuntime: runtime, model: piModel, agentDir, sessionDir: path.join(agentDir, 'sessions') },
      });

      const result = await agent.send('go');
      expect(result.text).toBe('delegated');
      expect(readFileSync(path.join(dir, 'note.txt'), 'utf8')).toBe('fixed\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(agentDir, { recursive: true, force: true });
    }
  }, 60_000);

  it('applies the pi sub-agent config permissions to its tool calls', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lousho-pidir-'));
    const agentDir = mkdtempSync(path.join(tmpdir(), 'lousho-pidir-pi-'));
    try {
      writeFileSync(path.join(dir, 'agent.json'), JSON.stringify({ model: 'mock/m' }));
      writeFileSync(path.join(dir, 'instructions.md'), 'lead\n');
      writeFileSync(path.join(dir, 'note.txt'), 'broken\n');
      mkdirSync(path.join(dir, 'subagents', 'coder'), { recursive: true });
      writeFileSync(
        path.join(dir, 'subagents', 'coder', 'agent.json'),
        JSON.stringify({
          description: 'Edits files with Pi tools.',
          engine: 'pi',
          permissions: [{ tool: 'edit', action: 'deny', reason: 'No edits' }],
        })
      );

      const runtime = await ModelRuntime.create({
        authPath: path.join(agentDir, 'auth.json'),
        modelsStorePath: path.join(agentDir, 'models.json'),
        refreshOnCreate: false,
      });
      const faux = fauxProvider();
      runtime.registerNativeProvider(faux.provider);
      const piModel = runtime.getModel('faux', 'faux-1')!;
      faux.setResponses([
        (context) => {
          const last = context.messages.at(-1);
          if (last?.role === 'toolResult') return fauxAssistantMessage('The edit was refused.');
          return fauxAssistantMessage(fauxToolCall('edit', { path: 'note.txt', edits: [{ oldText: 'broken', newText: 'fixed' }] }));
        },
      ]);

      const agent = await loadAgentDir(dir, {
        provider: mockModel([
          { toolCalls: [{ name: 'task', args: { agent: 'coder', prompt: 'Fix note.txt', description: 'fix note' } }] },
          { text: 'delegated' },
        ]),
        piAgent: { modelRuntime: runtime, model: piModel, agentDir, sessionDir: path.join(agentDir, 'sessions') },
      });

      await agent.send('go');
      expect(readFileSync(path.join(dir, 'note.txt'), 'utf8')).toBe('broken\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(agentDir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('validation errors', () => {
  it('names the directory when instructions are missing', async () => {
    const dir = fixture('err-no-instructions');
    const error = await resolveAgentDir(dir).catch((e: Error) => e);
    expect((error as Error).message).toContain(dir);
    expect((error as Error).message).toContain(path.join(dir, 'instructions.md'));
    expect((error as Error).message).toMatch(/has no instructions/);
  });

  it('says what a tools file exported, and shows a defineTool example', async () => {
    const file = path.join(fixture('err-bad-tool'), 'tools', 'nothing.ts');
    const error = (await resolveAgentDir(fixture('err-bad-tool')).catch((e: Error) => e)) as Error;
    expect(error.message).toContain(file);
    expect(error.message).toContain('default: object, helper: number');
    expect(error.message).toContain('defineTool({ name:');
  });

  it('names both files for a duplicate tool name', async () => {
    const dir = path.join(fixture('err-dup-tools'), 'tools');
    const error = (await resolveAgentDir(fixture('err-dup-tools')).catch((e: Error) => e)) as Error;
    expect(error.message).toContain("duplicate tool name 'same_name'");
    expect(error.message).toContain(path.join(dir, 'one.ts'));
    expect(error.message).toContain(path.join(dir, 'two.ts'));
  });

  it('suggests the right key for unknown config keys', async () => {
    const file = path.join(fixture('err-unknown-key'), 'agent.json');
    const error = (await resolveAgentDir(fixture('err-unknown-key')).catch((e: Error) => e)) as Error;
    expect(error.message).toContain(file);
    expect(error.message).toContain("'modle' (did you mean 'model'?)");
    expect(error.message).toContain("'prompt2'");
    expect(error.message).toContain('Allowed keys:');
  });

  it('requires a description on a sub-agent directory', async () => {
    const dir = path.join(fixture('err-subagent-no-description'), 'subagents', 'helper');
    const error = (await resolveAgentDir(fixture('err-subagent-no-description'), {
      provider: mockModel(['x']),
    }).catch((e: Error) => e)) as Error;
    expect(error.message).toContain(dir);
    expect(error.message).toContain("needs a 'description'");
  });

  it('rejects two config files, double instructions and invalid JSON, each naming the path', async () => {
    await expect(resolveAgentDir(fixture('err-two-configs'))).rejects.toThrow(
      /more than one config file \(agent\.json, agent\.yaml\)/
    );
    await expect(resolveAgentDir(fixture('err-double-instructions'))).rejects.toThrow(
      /instructions are given twice/
    );
    await expect(resolveAgentDir(fixture('err-bad-json'))).rejects.toThrow(
      new RegExp(`${path.join(fixture('err-bad-json'), 'agent.json').replace(/\\/g, '\\\\')}: invalid JSON`)
    );
  });

  it('names the rules that are wrong in permissions, one message per file', async () => {
    const file = path.join(fixture('err-bad-permissions'), 'agent.json');
    const error = (await resolveAgentDir(fixture('err-bad-permissions')).catch((e: Error) => e)) as Error;
    expect(error.message).toContain(file);
    expect(error.message).toMatch(/'permissions\[0\]'\.action must be 'allow', 'deny' or 'ask'/);
  });

  it('fails a missing hooks file naming the config path it came from', async () => {
    const file = path.join(fixture('err-missing-hooks'), 'agent.json');
    const error = (await resolveAgentDir(fixture('err-missing-hooks')).catch((e: Error) => e)) as Error;
    expect(error.message).toContain(file);
    expect(error.message).toContain("'hooks'");
    expect(error.message).toContain('nope/hooks.ts');
  });
});

describe('helpers', () => {
  it('explains a missing TypeScript loader with the fix, only for .ts files', () => {
    const cause = Object.assign(new Error('Unknown file extension ".ts"'), {
      code: 'ERR_UNKNOWN_FILE_EXTENSION',
    });
    const ts = explainImportError('/x/tools/a.ts', cause);
    expect(ts.message).toContain('/x/tools/a.ts');
    expect(ts.message).toContain('npx tsx your-script.ts');
    expect(ts.message).toContain('compile');
    expect(explainImportError('/x/tools/a.js', cause).message).toContain('failed to import /x/tools/a.js');
    expect(explainImportError('/x/a.ts', new Error('boom')).message).toContain('failed to import /x/a.ts: boom');
  });

  it('codes an unresolvable package import with a hint naming the package and where Node looks for it', () => {
    const esm = Object.assign(new Error("Cannot find package '@lousho/build-ai-agent' imported from /k/tools/fs.ts"), { code: 'ERR_MODULE_NOT_FOUND' });
    const error = explainImportError('/k/tools/fs.ts', esm) as SDKError;
    expect(error).toBeInstanceOf(SDKError);
    expect(error.code).toBe('LOUSHO_AGENT_DIR_INVALID');
    expect(error.message).toContain('failed to import /k/tools/fs.ts');
    expect(error.hint).toContain('npm install @lousho/build-ai-agent');
    expect(error.hint).toContain('node_modules');
    const cjs = Object.assign(new Error("Cannot find module 'zod/v4'\nRequire stack:\n- /k/a.ts"), { code: 'MODULE_NOT_FOUND' });
    expect((explainImportError('/k/a.ts', cjs) as SDKError).hint).toContain('npm install zod');
    // A missing relative file is not a package to install; it keeps the generic code and hint.
    const relative = Object.assign(new Error("Cannot find module './helpers'"), { code: 'MODULE_NOT_FOUND' });
    const plain = explainImportError('/k/a.ts', relative) as SDKError;
    expect(plain.code).toBe('LOUSHO_AGENT_DIR_INVALID');
    expect(plain.hint).not.toContain('npm install');
  });

  it('suggests close keys and nothing for distant ones', () => {
    expect(closest('maxStep', ['maxSteps', 'name'])).toBe('maxSteps');
    expect(closest('prompt', ['instructions', 'name'])).toBe('instructions');
    expect(closest('zzzzzzzz', ['maxSteps', 'name'])).toBeUndefined();
  });
});
