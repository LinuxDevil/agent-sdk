import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { mockModel, type MockModel, type MockTurn } from '../../testing';
import type { Span } from '../../execution/tracing';
import { defineTool } from '../../tools/defineTool';
import type { ToolDescriptor } from '../../types';
import { readFixtureTree } from '../__fixtures__/readTree';
import type { PageEngine, PageInput, PageResult, PageRunContext, PageRunEvent } from '../contracts/execution';
import type { WorkspacePolicy } from '../contracts/policy';
import { memorySource } from '../source/memorySource';
import { artifactSink, memoryArtifactStore } from './artifacts';
import { ENGINES, engineFor } from './engines';
import type { PageRuntimeHost, PageToolScope } from './engines/types';
import { loadWorkspace, type LoadedWorkspace } from './loadWorkspace';
import { runPage, type PageRuntimeContext } from './pageRuntime';

const CEILING: WorkspacePolicy = { permissions: [], tools: { allow: ['*'] }, secrets: [{ env: 'REPO_TOKEN' }], network: { allowHosts: ['api.example.com', 'cdn.example.com'] } };

function codingFiles(extra: Record<string, string> = {}): Record<string, string> {
  const tree = readFixtureTree('coding');
  const files = Object.fromEntries(Object.entries(tree).map(([path, value]) => [path, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`]));
  return { ...files, ...extra };
}

const load = (extra?: Record<string, string>): Promise<LoadedWorkspace> => loadWorkspace(memorySource(codingFiles(extra)), { mode: 'default' });

function hostWith(model: MockModel, overrides: Partial<PageRuntimeHost> = {}): PageRuntimeHost {
  return { tools: {}, ceiling: CEILING, bindTool: (descriptor) => descriptor, provider: () => model, ...overrides };
}

function context(host: PageRuntimeHost, runId: string, extra: Partial<PageRuntimeContext> = {}): PageRuntimeContext {
  return { host, runId, artifacts: artifactSink(memoryArtifactStore(), { workspace: 'coding', runId }), ...extra };
}

const triage = (inputs: unknown, task = 'Rank this report.'): PageInput => ({ pageId: 'support-triage', task, inputs });

const userTexts = (model: MockModel, call: number): string[] => model.calls[call].messages.filter((message) => message.role === 'user').map((message) => String(message.content));

describe('runPage', () => {
  it('invalid inputs fail before any model call', async () => {
    const workspace = await load();
    const model = mockModel(['{"ranking":"high"}']);
    const result = await runPage(workspace, triage({ report: 42 }), context(hostWith(model), 'run-1'));
    expect(result.status).toBe('failed');
    expect(result.error?.kind).toBe('invalid-input');
    expect(result.error?.message).toContain('inputs.report');
    expect(model.calls).toHaveLength(0);
  });

  it('an invalid output gets one repair turn, then fails', async () => {
    const workspace = await load();
    const inputs: PageInput[] = [];
    const engine: PageEngine = {
      type: 'single',
      run: async (input, ctx) => {
        inputs.push(input);
        return { status: 'ok', output: { wrong: true }, artifacts: [], summary: 'done', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, runId: ctx.runId };
      },
    };
    const result = await runPage(workspace, triage({ report: 'The site is down.' }), context(hostWith(mockModel([])), 'run-2', { engines: { single: () => engine } }));
    expect(inputs).toHaveLength(2);
    expect(inputs[1].revise?.runId).toBe('run-2');
    expect(inputs[1].revise?.instruction).toMatch(/^your output failed: output\.ranking/);
    expect(result.status).toBe('failed');
    expect(result.error?.kind).toBe('invalid-output');
    expect(result.output).toBeUndefined();
    expect(result.usage.totalTokens).toBe(4);
  });

  it('the single engine repairs in the same session and returns the valid output', async () => {
    const workspace = await load();
    const model = mockModel(['{"wrong":1}', '{"wrong":2}', '{"ranking":"urgent"}']);
    const result = await runPage(workspace, triage({ report: 'The site is down.' }), context(hostWith(model), 'run-3'));
    expect(result.status).toBe('ok');
    expect(result.output).toEqual({ ranking: 'urgent' });
    expect(userTexts(model, 2).some((text) => text.startsWith('your output failed: output.ranking'))).toBe(true);
    expect(userTexts(model, 2)[0]).toContain('Rank this report.');
  });

  it('the single engine fails invalid-output when the repair turn is still invalid', async () => {
    const workspace = await load();
    const model = mockModel(['{"wrong":1}'], { onExhausted: 'repeat-last' });
    const result = await runPage(workspace, triage({ report: 'The site is down.' }), context(hostWith(model), 'run-4'));
    expect(result.status).toBe('failed');
    expect(result.error?.kind).toBe('invalid-output');
    expect(result.error?.message).toContain('output.ranking');
  });

  it('the page session does not contain the main transcript', async () => {
    const workspace = await load();
    const model = mockModel(['{"ranking":"low"}', '{"ranking":"high"}']);
    const host = hostWith(model);
    await runPage(workspace, { ...triage({ report: 'A typo on the pricing page.' }), parentRunId: 'main-run' }, context(host, 'run-5'));
    const prior: PageResult = { status: 'ok', output: { ranking: 'low' }, artifacts: [], summary: 'Ranked low.', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, runId: 'run-5' };
    await runPage(workspace, { ...triage({ report: 'A typo on the pricing page.' }), revise: { runId: 'run-5', instruction: 'Rank it higher.' } }, context(host, 'run-6', { prior }));
    for (const call of [0, 1]) {
      const roles = model.calls[call].messages.map((message) => message.role);
      expect(roles.filter((role) => role !== 'system')).toEqual(['user']);
    }
    const [first] = userTexts(model, 0);
    expect(first).toContain('Rank this report.');
    expect(first).toContain('A typo on the pricing page.');
    expect(first).not.toContain('main-run');
    const [revised] = userTexts(model, 1);
    expect(revised).toContain('Ranked low.');
    expect(revised).toContain('Rank it higher.');
    expect(revised).not.toContain('{"ranking":"low"}');
  });

  it('defaults an empty task to the UI title, else the page id', async () => {
    const titled = await load({ 'pages/support-triage/ui/page.ui.json': JSON.stringify({ schema: 'lousho.ui/1', title: 'Triage a report', layout: { type: 'stack', children: [{ type: 'textarea', bind: 'inputs.report', label: 'report' }, { type: 'runButton' }] } }) });
    const model = mockModel(['{"ranking":"low"}', '{"ranking":"low"}']);
    await runPage(titled, triage({ report: 'x' }, ' '), context(hostWith(model), 'run-7'));
    expect(userTexts(model, 0)[0].startsWith('Triage a report')).toBe(true);
    const untitled = await load();
    await runPage(untitled, triage({ report: 'x' }, ''), context(hostWith(model), 'run-8'));
    expect(userTexts(model, 1)[0].startsWith('support-triage')).toBe(true);
  });

  it('emits started, step and finished events with the run labels', async () => {
    const workspace = await load();
    const events: PageRunEvent[] = [];
    await runPage(workspace, triage({ report: 'x' }), context(hostWith(mockModel(['{"ranking":"low"}'])), 'run-9', { emit: (event) => events.push(event) }));
    expect(events.map((event) => (event.type === 'step' ? `step.${event.phase}` : event.type))).toEqual(['started', 'step.start', 'step.done', 'finished']);
    const step = events.find((event) => event.type === 'step');
    expect(step).toMatchObject({ page: 'support-triage', attachment: 'agent', executionType: 'single', stepKind: 'single', stepIndex: 0 });
  });

  it('a single-engine run stamps its step labels on the invoke_agent span', async () => {
    const workspace = await load();
    const ended: Span[] = [];
    const host = hostWith(mockModel(['{"ranking":"low"}']), { exporter: { onSpanStart: () => undefined, onSpanEnd: (span) => ended.push({ ...span }) } });
    const events: PageRunEvent[] = [];
    await runPage(workspace, triage({ report: 'x' }), context(host, 'run-16', { emit: (event) => events.push(event) }));
    const invoke = ended.find((span) => span.attributes['gen_ai.operation.name'] === 'invoke_agent');
    expect(invoke?.attributes).toMatchObject({ 'lousho.workspace': 'coding', 'lousho.page': 'support-triage', 'lousho.attachment': 'agent', 'lousho.execution_type': 'single', 'lousho.step.kind': 'single', 'lousho.step.index': 0 });
    const step = events.find((event) => event.type === 'step');
    expect(invoke?.attributes['lousho.harness.hash']).toBe(step && 'harnessHash' in step ? step.harnessHash : undefined);
    expect(typeof invoke?.attributes['lousho.harness.part_hash']).toBe('string');
  });

  it('a required artifact the run did not produce is an invalid output', async () => {
    const harness = JSON.parse(codingFiles()['pages/support-triage/harness/harness.json']) as { outputs: Record<string, unknown> };
    harness.outputs.artifacts = [{ name: 'ranking.md', mediaType: 'text/markdown', required: true }];
    const workspace = await load({ 'pages/support-triage/harness/harness.json': JSON.stringify(harness) });
    const stored: string[] = [];
    const engine: PageEngine = {
      type: 'single',
      run: async (input, ctx: PageRunContext) => {
        if (input.revise) stored.push((await ctx.artifacts.put('ranking.md', '# High', 'text/markdown')).name);
        return { status: 'ok', output: { ranking: 'high' }, artifacts: [], summary: 'done', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, runId: ctx.runId };
      },
    };
    const result = await runPage(workspace, triage({ report: 'x' }), context(hostWith(mockModel([])), 'run-10', { engines: { single: () => engine } }));
    expect(stored).toEqual(['ranking.md']);
    expect(result.status).toBe('ok');
    expect(result.artifacts.map((ref) => ref.name)).toEqual(['ranking.md']);
  });

  it('gives each tool only through the host bindTool, with its secrets, network and sandbox scope', async () => {
    const policy = { ...(JSON.parse(codingFiles()['shared/policies/policy.json']) as object), secrets: [{ env: 'REPO_TOKEN' }, { env: 'OTHER_TOKEN' }], network: { allowHosts: ['api.example.com'] } };
    const workspace = await load({ 'agents/triager/tools/read_file.ts': 'export {};\n', 'agents/triager/tools/bash.ts': 'export {};\n', 'shared/policies/policy.json': JSON.stringify(policy) });
    const execute = vi.fn(async () => 'file text');
    const readFile = defineTool({ name: 'read_file', description: 'Reads a file.', input: z.object({ path: z.string() }), execute });
    const scopes: PageToolScope[] = [];
    const bindTool = (descriptor: ToolDescriptor, scope: PageToolScope): ToolDescriptor => {
      scopes.push(scope);
      return descriptor;
    };
    const turns: MockTurn[] = [{ toolCalls: [{ name: 'read_file', args: { path: 'README.md' } }] }, '{"ranking":"low"}'];
    const model = mockModel(turns);
    const host = hostWith(model, { tools: { read_file: { descriptor: readFile, secrets: [{ env: 'REPO_TOKEN' }, { env: 'OTHER_TOKEN' }] }, bash: { descriptor: defineTool({ name: 'bash', description: 'Runs bash.', input: z.object({}), execute: async () => '' }) } }, bindTool });
    const result = await runPage(workspace, triage({ report: 'x' }), context(host, 'run-11'));
    expect(result.status).toBe('ok');
    expect(scopes).toEqual([{ name: 'read_file', page: 'support-triage', attachment: 'agent', secrets: [{ env: 'REPO_TOKEN' }], network: { allowHosts: ['api.example.com'] }, sandbox: { required: true } }]);
    expect(execute).toHaveBeenCalledOnce();
    expect(model.calls[0].tools?.map((item) => item.function.name)).toEqual(['read_file']);
  });

  it('a cancelled signal ends the run cancelled', async () => {
    const workspace = await load();
    const controller = new AbortController();
    controller.abort();
    const result = await runPage(workspace, triage({ report: 'x' }), context(hostWith(mockModel(['{"ranking":"low"}'])), 'run-12', { signal: controller.signal }));
    expect(result.status).toBe('cancelled');
    expect(result.error?.kind).toBe('cancelled');
  });

  it('an engine that throws fails the run with kind engine', async () => {
    const workspace = await load();
    const engine: PageEngine = {
      type: 'single',
      run: async () => {
        throw new TypeError('the engine broke');
      },
    };
    const result = await runPage(workspace, triage({ report: 'x' }), context(hostWith(mockModel([])), 'run-13', { engines: { single: () => engine } }));
    expect(result).toMatchObject({ status: 'failed', error: { kind: 'engine', message: 'the engine broke' } });
  });

  it('without an output schema the output is the reply text, and a non-JSON reply under a schema is invalid', async () => {
    const harness = JSON.parse(codingFiles()['pages/support-triage/harness/harness.json']) as { outputs?: unknown };
    delete harness.outputs;
    const plain = await load({ 'pages/support-triage/harness/harness.json': JSON.stringify(harness), 'pages/support-triage/ui/page.ui.json': JSON.stringify({ schema: 'lousho.ui/1', layout: { type: 'stack', children: [{ type: 'textarea', bind: 'inputs.report', label: 'report' }, { type: 'runButton' }] } }) });
    const text = await runPage(plain, triage({ report: 'x' }), context(hostWith(mockModel(['Ranked high.'])), 'run-14'));
    expect(text).toMatchObject({ status: 'ok', output: 'Ranked high.', summary: 'Ranked high.' });
    const structured = await runPage(await load(), triage({ report: 'x' }), context(hostWith(mockModel(['not json'], { onExhausted: 'repeat-last' })), 'run-15'));
    expect(structured.error?.kind).toBe('invalid-output');
  });
});

describe('engine registry', () => {
  it('engine registry rejects an unknown type', () => {
    expect(() => engineFor('bogus')).toThrow(expect.objectContaining({ code: 'LOUSHO_WORKSPACE_ENGINE_UNKNOWN' }));
    expect(() => engineFor('toString')).toThrow(expect.objectContaining({ code: 'LOUSHO_WORKSPACE_ENGINE_UNKNOWN' }));
    expect(() => engineFor('workflow')).toThrow(/no engine runs execution type 'workflow'; this runtime has 'single'/);
  });

  it('ships the single engine', () => {
    expect(Object.keys(ENGINES)).toEqual(['single']);
    expect(engineFor('single')).toBe(ENGINES.single);
  });
});
