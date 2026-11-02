/**
 * `buildRunnableAgent` (server/buildAgentV2.ts): one case per D12a
 * acceptance criterion. Runs go through the SDK's spec-v2 compiler
 * (`compileSpec`) with Studio's stores/keys wired in - the mock provider
 * (`mock/mock-1`) drives deterministic tool calls: it calls a tool whose
 * model-facing name appears in the last user message (see
 * src/providers/mock.ts's extractToolCalls).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  createAgentConfigOf,
  type AgentEvent,
  type AgentSpecV2,
} from 'lousho';
type Global = { __hookOrder?: string[] };
import { buildRunnableAgent, scopedApprovalStore, type RunWiring } from '../buildAgentV2';
import { FileApprovalStore } from '../approvalStore';
import { FileCheckpointStore } from '../checkpointStore';
import { SecretsStore } from '../secretsStore';

const BASE: AgentSpecV2 = {
  version: 2,
  name: 'test-agent',
  model: 'mock/mock-1',
  instructions: 'You are a helpful agent.',
};

function noopWiring(): { events: AgentEvent[]; wiring: RunWiring } {
  const events: AgentEvent[] = [];
  return {
    events,
    wiring: {
      onEvent: (event: AgentEvent) => events.push(event),
      exporter: { onSpanStart: () => {}, onSpanEnd: () => {} },
    },
  };
}

describe('buildRunnableAgent', () => {
  let baseDir: string;
  let approvalStore: FileApprovalStore;
  let checkpointStore: FileCheckpointStore;
  const savedEnv = { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-buildv2-'));
    approvalStore = new FileApprovalStore(baseDir);
    checkpointStore = new FileCheckpointStore(baseDir);
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    if (savedEnv.ANTHROPIC_API_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedEnv.ANTHROPIC_API_KEY;
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  const deps = () => ({ baseDir, checkpointStore, approvalStore });

  it('an ask permission rule pauses the run, filed under .lousho/agents/<agentId>/approvals/', async () => {
    const agentId = 'perm-agent';
    const spec: AgentSpecV2 = {
      ...BASE,
      tools: [{ builtin: 'current_date' }],
      permissions: [{ id: 'p1', tool: 'current_date', action: 'ask' }],
    };
    const { wiring } = noopWiring();
    const built = await buildRunnableAgent(spec, agentId, deps(), wiring);

    const result = await built.agent.send('please use current_date', { sessionId: agentId });
    expect(result.finishReason).toBe('awaiting-approval');
    expect(result.approvalId).toBeTruthy();

    const dir = path.join(baseDir, '.lousho', 'agents', agentId, 'approvals');
    expect(fs.existsSync(path.join(dir, `${result.approvalId}.json`))).toBe(true);
    const record = await approvalStore.peek(agentId, result.approvalId!);
    expect(record?.pending.toolName).toBe('current_date');
  });

  it('an input guardrail trips and reports guardrail.tripped to onEvent', async () => {
    const spec: AgentSpecV2 = {
      ...BASE,
      guardrails: [{ id: 'g1', name: 'max-length', on: 'input', options: { maxChars: 10 } }],
    };
    const { events, wiring } = noopWiring();
    const built = await buildRunnableAgent(spec, 'guard-agent', deps(), wiring);

    await built.agent.send('this input is definitely longer than ten characters');
    expect(events.some((e) => e.type === 'guardrail.tripped')).toBe(true);
  });

  it('carries the spec\'s mcpServers into the createAgent config without connecting (lazy)', async () => {
    const spec: AgentSpecV2 = {
      ...BASE,
      mcpServers: { things: { command: 'definitely-not-a-real-mcp-server-binary' } },
    };
    const { wiring } = noopWiring();
    const built = await buildRunnableAgent(spec, 'mcp-agent', deps(), wiring);
    expect(Object.keys(createAgentConfigOf(built.agent)?.mcpServers ?? {})).toContain('things');
  });

  it('an anthropic model with a stored key builds; with neither key nor env it throws LOUSHO_PROVIDER_MISSING_API_KEY', async () => {
    const secretsStore = new SecretsStore(baseDir);
    const spec: AgentSpecV2 = { ...BASE, model: 'anthropic/claude-haiku-5-5' };
    await expect(buildRunnableAgent(spec, 'a1', { ...deps(), secretsStore }, noopWiring().wiring)).rejects.toMatchObject({
      code: 'LOUSHO_PROVIDER_MISSING_API_KEY',
    });
    secretsStore.setKey('anthropic', 'sk-ant-test');
    const built = await buildRunnableAgent(spec, 'a1', { ...deps(), secretsStore }, noopWiring().wiring);
    expect(built.modelLabel).toBe('anthropic/claude-haiku-5-5');
  });

  it('a { secret } ref resolves through secretsStore.getSecret', async () => {
    const secretsStore = new SecretsStore(baseDir);
    secretsStore.setSecret('MY_TOKEN', 's3cr3t');
    const spec: AgentSpecV2 = {
      ...BASE,
      mcpServers: { svc: { command: 'no-such-mcp-bin', env: { TOKEN: { secret: 'MY_TOKEN' } } } },
    };
    const { wiring } = noopWiring();
    const built = await buildRunnableAgent(spec, 'sec-agent', { ...deps(), secretsStore }, wiring);
    const servers = createAgentConfigOf(built.agent)?.mcpServers as Record<string, { env?: Record<string, string> }>;
    expect(servers.svc.env?.TOKEN).toBe('s3cr3t');

    // And a missing secret fails the build with the SDK's code.
    const missing: AgentSpecV2 = {
      ...BASE,
      mcpServers: { svc: { command: 'no-such-mcp-bin', env: { TOKEN: { secret: 'NOPE' } } } },
    };
    await expect(
      buildRunnableAgent(missing, 'sec-agent', { ...deps(), secretsStore }, noopWiring().wiring)
    ).rejects.toMatchObject({ code: 'LOUSHO_SPEC_SECRET_MISSING' });
  });

  it('extraHooks run after the spec\'s own hooks', async () => {
    const orderKey = '__hookOrder';
    const spec: AgentSpecV2 = {
      ...BASE,
      hooks: [{ id: 'spec-hook', file: 'spec-hook.js' }],
    };
    // A `{ file }` hook resolves under <baseDir>/.lousho/agents - write one
    // there. Both hooks append to ONE shared order so the assertion proves
    // sequence, not merely that each ran.
    const hooksDir = path.join(baseDir, '.lousho', 'agents');
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(
      path.join(hooksDir, 'spec-hook.js'),
      `module.exports = { name: "spec-hook", preGenerate: () => { (globalThis.${orderKey} ??= []).push('spec-hook'); } };\n`
    );
    const { wiring } = noopWiring();
    wiring.extraHooks = [
      {
        name: 'extra-hook',
        preGenerate: () => {
          ((globalThis as Global).__hookOrder ??= []).push('extra-hook');
        },
      },
    ];
    const built = await buildRunnableAgent(spec, 'hook-agent', deps(), wiring);
    await built.agent.send('hi');
    expect((globalThis as Global).__hookOrder).toEqual(['spec-hook', 'extra-hook']);
  });

  it('instructionsByFamily is picked against the REAL spec.model (the stored-key compile path cannot substitute the model string)', async () => {
    const secretsStore = new SecretsStore(baseDir);
    secretsStore.setKey('anthropic', 'sk-ant-test');
    // 'claude' applies to anthropic/claude-* models; 'openai' must not leak
    // in, and a stand-in model would have lost the tail entirely.
    const spec: AgentSpecV2 = {
      ...BASE,
      model: 'anthropic/claude-haiku-5-5',
      instructions: 'BASE.',
      instructionsByFamily: { claude: 'CLAUDE-TAIL.', openai: 'OPENAI-TAIL.' } as AgentSpecV2['instructionsByFamily'],
    };
    const built = await buildRunnableAgent(spec, 'fam-agent', { ...deps(), secretsStore }, noopWiring().wiring);
    const instructions = createAgentConfigOf(built.agent)?.instructions;
    expect(instructions).toContain('CLAUDE-TAIL.');
    expect(instructions).not.toContain('OPENAI-TAIL.');

    // And a mock model picks the 'mock' family, not a real-provider tail.
    const mockSpec: AgentSpecV2 = {
      ...BASE,
      instructions: 'BASE.',
      instructionsByFamily: { mock: 'MOCK-TAIL.', claude: 'WRONG-TAIL.' } as AgentSpecV2['instructionsByFamily'],
    };
    const mockBuilt = await buildRunnableAgent(mockSpec, 'fam-mock', deps(), noopWiring().wiring);
    const mockInstructions = createAgentConfigOf(mockBuilt.agent)?.instructions;
    expect(mockInstructions).toContain('MOCK-TAIL.');
    expect(mockInstructions).not.toContain('WRONG-TAIL.');
  });

  it('a spec\'s demo-approval ref joins the compiled tools (the Studio local tool)', async () => {
    const spec: AgentSpecV2 = {
      ...BASE,
      tools: [{ registry: 'demo-approval' }],
    };
    const { wiring } = noopWiring();
    const built = await buildRunnableAgent(spec, 'local-tool-agent', deps(), wiring);
    const result = await built.agent.send('please use demo-approval', { sessionId: 'local-tool-agent' });
    expect(result.finishReason).toBe('awaiting-approval');
  });
});

describe('scopedApprovalStore', () => {
  it('files saves under the given agentId regardless of pending.agentId', async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-scoped-'));
    try {
      const store = new FileApprovalStore(baseDir);
      const scoped = scopedApprovalStore(store, 'agent-x');
      const pending = { id: 'ap-1', agentId: 'other', toolName: 't', args: {}, createdAt: new Date().toISOString() };
      await scoped.save(pending as never, { messages: [] } as never);
      expect(await store.peek('agent-x', 'ap-1')).not.toBeNull();
      expect(await store.peek('other', 'ap-1')).toBeNull();
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });
});
