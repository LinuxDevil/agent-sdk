import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { FlowExecutor } from '../../flows/FlowExecutor';
import type { FlowSpec } from '../../flows/types';
import type { GenerateOptions, LLMProvider } from '../../providers';
import { MockLLMProvider } from '../../providers/mock';
import { mockModel, type MockTurn } from '../../testing';
import { defineTool } from '../../tools/defineTool';
import { readFixtureTree } from '../__fixtures__/readTree';
import type { PageInput, PageResult } from '../contracts/execution';
import { FORBIDDEN_HARNESS_KEYS } from '../contracts/forbiddenKeys';
import type { WorkspacePolicy } from '../contracts/policy';
import { memorySource } from '../source/memorySource';
import { memoryArtifactStore } from '../runtime/artifacts';
import { fileHostBackend } from '../runtime/backends';
import type { PageEngineFactory, PageToolScope } from '../runtime/engines/types';
import type { HostToolRegistry } from '../runtime/policy';
import { jsonOf } from '../runtime/profileStore';
import { createWorkspaceStores, type WorkspaceStores } from '../runtime/stores';
import type { WorkspaceHost } from '../runtime/workspaceHost';
import { createWorkspaceRuntime, type WorkspaceRunEvent } from '../runtime/workspaceRuntime';

const CEILING: WorkspacePolicy = { permissions: [], tools: { allow: ['*'] }, secrets: [] };

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const asText = (value: unknown): string => (typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);

function files(extra: Record<string, unknown> = {}): Record<string, string> {
  const tree = { ...readFixtureTree('coding'), ...extra };
  return Object.fromEntries(Object.entries(tree).map(([path, value]) => [path, asText(value)]));
}

function fixtureJson(path: string): Record<string, unknown> {
  return (readFixtureTree('coding') as Record<string, unknown>)[path] as Record<string, unknown>;
}

function storesFor(workspaceId: string): WorkspaceStores {
  const dir = mkdtempSync(join(tmpdir(), 'lousho-g6-'));
  dirs.push(dir);
  return createWorkspaceStores(fileHostBackend(dir), { projectId: 'proj-1', workspaceId });
}

function testHost(workspaceId: string, providers: Record<string, LLMProvider>, extra: Partial<Omit<WorkspaceHost, 'stores'>> = {}): WorkspaceHost & { stores: WorkspaceStores & WorkspaceHost['stores'] } {
  let next = 0;
  return {
    tools: {},
    policyCeiling: CEILING,
    providers: {
      resolve(ref) {
        const provider = providers[ref];
        if (!provider) throw new Error(`no provider for ${ref}`);
        return provider;
      },
    },
    secrets: { resolve: async () => undefined },
    stores: { ...storesFor(workspaceId), artifacts: memoryArtifactStore() },
    globals: { agents: { resolve: async () => undefined }, profiles: { get: (ref) => { throw new Error(`no global profile ${ref}`); } } },
    newRunId: () => `run-${++next}`,
    ...extra,
  };
}

const tool = (name: string, execute = vi.fn(async () => `${name} ran`)) => defineTool({ name, description: `The ${name} tool`, input: z.object({ value: z.string().optional() }), execute });

const spies = new Map<string, ReturnType<typeof vi.fn>>();

function registry(...names: string[]): HostToolRegistry {
  return Object.fromEntries(names.map((name) => {
    const execute = vi.fn(async () => `${name} ran`);
    spies.set(name, execute);
    return [name, { descriptor: tool(name, execute) }];
  }));
}

const executeOf = (_tools: HostToolRegistry, name: string) => spies.get(name);

const TRIAGE: Omit<PageInput, 'pageId'> = { task: 'Rank this report.', inputs: { report: 'The site is down.' } };

const toolNames = (call: GenerateOptions | undefined): string[] => (call?.tools ?? []).map((entry) => entry.function.name).sort();

const toolMessages = (call: GenerateOptions | undefined): string => (call?.messages ?? []).filter((message) => message.role === 'tool').map((message) => String(message.content)).join('\n');

const callTool = (name: string): MockTurn => ({ toolCalls: [{ name, args: {} }] });

const RANKED = '{"ranking":"high"}';

const toolFiles = (dir: string, ...names: string[]): Record<string, string> => Object.fromEntries(names.map((name) => [`${dir}/tools/${name}.ts`, 'export {};\n']));

function runtimeFor(tree: Record<string, string>, extra: Partial<Omit<WorkspaceHost, 'stores'>> = {}, model = mockModel([RANKED], { onExhausted: 'repeat-last' })) {
  const host = testHost('coding', { 'mock/mock-model': model }, { bindTool: (descriptor) => descriptor, ...extra });
  return { runtime: createWorkspaceRuntime(memorySource(tree), host), model, host };
}

async function refusal(work: Promise<unknown>): Promise<{ code?: string; message: string }> {
  const error = await work.then(
    () => undefined,
    (thrown: unknown) => thrown as { code?: string; message: string }
  );
  if (error === undefined) throw new Error('the attempt was not refused');
  return error;
}

async function collect(events: AsyncIterable<WorkspaceRunEvent>): Promise<WorkspaceRunEvent[]> {
  const all: WorkspaceRunEvent[] = [];
  for await (const event of events) all.push(event);
  return all;
}

const flowStep = (toolName: string): FlowSpec => ({ code: 'apply-fix', name: 'Apply fix', flow: { type: 'toolCall', id: 'apply', tool: toolName, arguments: { value: 'patch' } } as FlowSpec['flow'] });

const workflowEngine: PageEngineFactory = (setup) => ({
  type: 'workflow',
  async run(_input, ctx): Promise<PageResult> {
    const name = String(setup.page.execution.workflow?.workflow).replace(/^workspace:/, '');
    const path = `workflows/${name}/workflow.json`;
    const flow = jsonOf(setup.workspace.tree[path], path) as FlowSpec;
    const [alias] = Object.keys(setup.attachments);
    const { policy } = setup.attachments[alias];
    const result = await FlowExecutor.execute(flow, {
      agent: { id: alias, name: alias, prompt: 'Run the steps.', settings: { model: 'mock' } },
      provider: new MockLLMProvider({ name: 'mock', responses: [] }),
      variables: {},
      toolRegistry: policy.toolRegistry,
      permissions: policy.permissions,
    });
    const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    if (result.success) return { status: 'ok', output: { ranking: 'done' }, artifacts: [], summary: 'ran', usage, runId: ctx.runId };
    const error = result.error as { code?: string; message: string };
    return { status: 'failed', artifacts: [], summary: error.message, usage, runId: ctx.runId, error: { kind: 'engine', message: `${error.code}: ${error.message}` } };
  },
});

function workflowPage(toolName: string): Record<string, unknown> {
  return {
    'pages/support-triage/page.json': { ...fixtureJson('pages/support-triage/page.json'), execution: { type: 'workflow', workflow: { workflow: 'workspace:apply-fix' } } },
    'workflows/apply-fix/workflow.json': flowStep(toolName),
  };
}

describe('G6: page config cannot bypass workspace security', () => {
  it.each(FORBIDDEN_HARNESS_KEYS.map((key) => [key]))('1. a harness that sets %s is refused at load, naming R13', async (key) => {
    const harness = { ...fixtureJson('pages/support-triage/harness/harness.json'), [key]: key === 'model' ? 'mock/mock-model' : { allow: ['*'] } };
    const { runtime, model } = runtimeFor(files({ 'pages/support-triage/harness/harness.json': harness }));
    const error = await refusal(runtime.runPage('support-triage', TRIAGE));
    expect(error.code).toBe('LOUSHO_WORKSPACE_INVALID');
    expect(error.message).toContain(`PRD001 pages/support-triage/harness/harness.json#${key}`);
    expect(error.message).toContain('(R13)');
    expect(model.calls).toHaveLength(0);
    await runtime.close();
  });

  it('2. an agents.json attachment with tools.add is refused at load, naming R13', async () => {
    const agents = { schema: 'lousho.agents/1', agents: [{ as: 'agent', ref: 'workspace:triager', role: 'Ranks the report.', tools: { add: ['bash'] } }] };
    const { runtime, model } = runtimeFor(files({ 'pages/support-triage/agents.json': agents }));
    const error = await refusal(runtime.runPage('support-triage', TRIAGE));
    expect(error.code).toBe('LOUSHO_WORKSPACE_INVALID');
    expect(error.message).toMatch(/PRD005 pages\/support-triage\/agents\.json#agents\.0\.tools\.add .*\(R13\)/);
    expect(model.calls).toHaveLength(0);
    await runtime.close();
  });

  it('3. a local agent tool outside the allowlist is removed, and a model call to it gets an unknown-tool error', async () => {
    const tools = registry('read_file', 'deploy');
    const model = mockModel([callTool('deploy'), RANKED]);
    const { runtime } = runtimeFor(files(toolFiles('agents/triager', 'read_file', 'deploy')), { tools }, model);
    const result = await runtime.runPage('support-triage', TRIAGE);
    expect(toolNames(model.calls[0])).toEqual(['read_file']);
    expect(toolMessages(model.calls[1])).toContain("Tool 'deploy' not found");
    expect(executeOf(tools, 'deploy')).not.toHaveBeenCalled();
    expect(result.status).toBe('ok');
    await runtime.close();
  });

  it('4. a workflow tool step on a tool the policy says needs approval is refused without one', async () => {
    const tools = registry('edit_file');
    const { runtime } = runtimeFor(files({ ...workflowPage('edit_file'), ...toolFiles('agents/triager', 'edit_file') }), { tools, engines: { workflow: workflowEngine } });
    const result = await runtime.runPage('support-triage', TRIAGE);
    expect(result.status).toBe('failed');
    expect(result.error?.message).toContain('LOUSHO_FLOW_TOOL_DENIED');
    expect(result.error?.message).toContain("Tool 'edit_file' needs approval");
    expect(executeOf(tools, 'edit_file')).not.toHaveBeenCalled();
    await runtime.close();
  });

  it("4b. an agent allow never lifts a host tool's own needsApproval, in a workflow step or a model call", async () => {
    const execute = vi.fn(async () => 'deleted');
    const tools: HostToolRegistry = { read_file: { descriptor: { ...tool('read_file', execute), needsApproval: true } } };
    const triager = { ...fixtureJson('agents/triager/agent.json'), permissions: [{ tool: 'read_file', action: 'allow' }] };
    const tree = { ...toolFiles('agents/triager', 'read_file'), 'agents/triager/agent.json': triager };
    const flow = runtimeFor(files({ ...tree, ...workflowPage('read_file') }), { tools, engines: { workflow: workflowEngine } });
    const stepped = await flow.runtime.runPage('support-triage', TRIAGE);
    expect(stepped.status).toBe('failed');
    expect(stepped.error?.message).toContain('LOUSHO_FLOW_TOOL_DENIED');
    await flow.runtime.close();
    const model = mockModel([callTool('read_file'), RANKED]);
    const single = runtimeFor(files(tree), { tools }, model);
    const called = await single.runtime.runPage('support-triage', TRIAGE);
    expect(called.status).toBe('needs-approval');
    expect(execute).not.toHaveBeenCalled();
    await single.runtime.close();
  });

  it('5. a global agent whose tools exceed the policy gets only the allowed ones', async () => {
    const tools = registry('read_file', 'deploy', 'bash');
    const agent = { format: 'dir' as const, dir: 'global/fact-checker', name: 'fact-checker', version: '1.2.0', files: { 'agent.json': asText({ name: 'fact-checker', version: '1.2.0' }), 'instructions.md': 'Check the claims.\n', ...toolFiles('', 'read_file', 'deploy', 'bash') } };
    agent.files = Object.fromEntries(Object.entries(agent.files).map(([path, text]) => [path.replace(/^\//, ''), text]));
    const agents = { schema: 'lousho.agents/1', agents: [{ as: 'agent', ref: 'global:fact-checker@^1.0.0', role: 'Ranks the report.' }] };
    const model = mockModel([callTool('bash'), callTool('deploy'), RANKED]);
    const { runtime } = runtimeFor(files({ 'pages/support-triage/agents.json': agents }), { tools, globals: { agents: { resolve: async () => agent }, profiles: { get: (ref) => { throw new Error(`no global profile ${ref}`); } } } }, model);
    const result = await runtime.runPage('support-triage', TRIAGE);
    expect(toolNames(model.calls[0])).toEqual(['read_file']);
    expect(toolMessages(model.calls[2])).toContain("Tool 'bash' was denied by a permission rule: Pages never run shell commands.");
    expect(toolMessages(model.calls[2])).toContain("Tool 'deploy' not found");
    expect(executeOf(tools, 'bash')).not.toHaveBeenCalled();
    expect(executeOf(tools, 'deploy')).not.toHaveBeenCalled();
    expect(result.status).toBe('ok');
    await runtime.close();
  });

  it('5b. a Studio global agent with host-only keys and a folder agent with code or host folders are refused', async () => {
    const studio = { format: 'studio' as const, dir: 'global/fact-checker', name: 'fact-checker', version: '1.0.0', files: { 'spec.json': asText({ version: 2, name: 'fact-checker', model: 'mock/mock-model', instructions: 'Check.', mcpServers: { evil: { command: 'evil' } } }) } };
    const agents = { schema: 'lousho.agents/1', agents: [{ as: 'agent', ref: 'global:fact-checker@^1.0.0', role: 'Ranks the report.' }] };
    const global = runtimeFor(files({ 'pages/support-triage/agents.json': agents }), { globals: { agents: { resolve: async () => studio }, profiles: { get: (ref) => { throw new Error(`no global profile ${ref}`); } } } });
    expect((await refusal(global.runtime.runPage('support-triage', TRIAGE))).message).toContain("'mcpServers' is not run for a workspace agent");
    await global.runtime.close();
    for (const [path, expected] of [
      ['agents/triager/hooks.ts', 'code files cannot be loaded from a workspace source'],
      ['agents/triager/subagents/helper/agent.json', 'a workspace agent does not run subagents'],
    ]) {
      const local = runtimeFor(files({ [path]: path.endsWith('.json') ? { name: 'helper' } : 'export {};\n' }));
      expect((await refusal(local.runtime.runPage('support-triage', TRIAGE))).message).toContain(expected);
      await local.runtime.close();
    }
  });

  it('6. a workspace policy that tries to widen the host ceiling is narrowed to it', async () => {
    const tools: HostToolRegistry = { read_file: { descriptor: tool('read_file'), secrets: [{ env: 'READ_KEY' }, { env: 'ROOT_KEY' }] }, deploy: { descriptor: tool('deploy') } };
    const ceiling: WorkspacePolicy = { permissions: [], tools: { allow: ['read_file'] }, secrets: [{ env: 'READ_KEY' }], network: { allowHosts: ['api.example.com'] }, sandbox: { required: true } };
    const widened: WorkspacePolicy = { permissions: [{ id: 'all', tool: '*', action: 'allow' }], tools: { allow: ['*'] }, secrets: [{ env: 'READ_KEY' }, { env: 'ROOT_KEY' }], network: { allowHosts: ['*.example.com', 'evil.example.org'] }, sandbox: { required: false } };
    const scopes: PageToolScope[] = [];
    const model = mockModel([callTool('deploy'), RANKED]);
    const { runtime } = runtimeFor(
      files({ 'shared/policies/policy.json': widened, ...toolFiles('agents/triager', 'read_file', 'deploy') }),
      { tools, policyCeiling: ceiling, bindTool: (descriptor, scope) => (scopes.push(scope), descriptor) },
      model
    );
    await runtime.runPage('support-triage', TRIAGE);
    expect(toolNames(model.calls[0])).toEqual(['read_file']);
    expect(toolMessages(model.calls[1])).toContain("Tool 'deploy' not found");
    expect(scopes).toEqual([{ name: 'read_file', page: 'support-triage', attachment: 'agent', secrets: [{ env: 'READ_KEY' }], network: { allowHosts: ['api.example.com'] }, sandbox: { required: true } }]);
    expect(executeOf(tools, 'deploy')).not.toHaveBeenCalled();
    await runtime.close();
  });

  it('a page capability that only a denied tool provides fails page start with capability-missing', async () => {
    const tools: HostToolRegistry = { read_file: { descriptor: tool('read_file'), capabilities: ['code.read'] } };
    const policy = { ...fixtureJson('shared/policies/policy.json'), permissions: [{ id: 'no-read', tool: 'read_file', action: 'deny', reason: 'No reading.' }] };
    const harness = { ...fixtureJson('pages/support-triage/harness/harness.json'), capabilities: { require: ['code.read'] } };
    const { runtime, model } = runtimeFor(files({ 'shared/policies/policy.json': policy, 'pages/support-triage/harness/harness.json': harness, ...toolFiles('agents/triager', 'read_file') }), { tools });
    const error = await refusal(runtime.runPage('support-triage', TRIAGE));
    expect(error.code).toBe('LOUSHO_WORKSPACE_CAPABILITY_MISSING');
    expect(error.message).toContain("capability-missing: the page requires 'code.read'");
    expect(model.calls).toHaveLength(0);
    await runtime.close();
  });

  it('a model the host resolver refuses blocks a page agent and the main agent that ask for it', async () => {
    const refuse = (ref: string): LLMProvider => {
      throw new Error(`model '${ref}' is not allowed on this host`);
    };
    const allowed = mockModel([RANKED], { onExhausted: 'repeat-last' });
    const providers = { resolve: (ref: string) => (ref === 'mock/mock-model' ? allowed : refuse(ref)) };
    const page = { ...fixtureJson('pages/support-triage/page.json'), defaults: { model: 'vendor/forbidden' } };
    const paged = runtimeFor(files({ 'pages/support-triage/page.json': page }), { providers });
    const pageError = await refusal(paged.runtime.runPage('support-triage', TRIAGE));
    expect(pageError.message).toContain("model 'vendor/forbidden' is not allowed on this host");
    await paged.runtime.close();
    const workspace = { ...fixtureJson('workspace.json'), defaults: { model: 'vendor/forbidden' } };
    const main = runtimeFor(files({ 'workspace.json': workspace }), { providers });
    const mainError = await refusal(collect(main.runtime.run('Rank this report.', { threadId: 'thread-m' })));
    expect(mainError.message).toContain("model 'vendor/forbidden' is not allowed on this host");
    expect(allowed.calls).toHaveLength(0);
    await main.runtime.close();
  });
});
