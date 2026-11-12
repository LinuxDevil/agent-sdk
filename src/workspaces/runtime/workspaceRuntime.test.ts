import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineTool } from '../../tools/defineTool';
import { mockModel, type MockTurn } from '../../testing';
import type { LLMProvider } from '../../providers';
import { readFixtureTree } from '../__fixtures__/readTree';
import type { PageEngineFactory, PageToolScope } from './engines/types';
import type { PageEngine, PageInput, PageUsage } from '../contracts/execution';
import type { WorkspacePolicy } from '../contracts/policy';
import { memorySource } from '../source/memorySource';
import type { WorkspaceSource } from '../source/types';
import { memoryArtifactStore } from './artifacts';
import { fileHostBackend } from './backends';
import type { EngineRegistry } from './engines/types';
import { createWorkspaceStores, type WorkspaceStores } from './stores';
import { pageHostOf, type WorkspaceHost } from './workspaceHost';
import { createWorkspaceRuntime, type WorkspaceRunEvent } from './workspaceRuntime';

const CEILING: WorkspacePolicy = { permissions: [], tools: { allow: ['*'] }, secrets: [] };

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function files(name: string, extra: Record<string, unknown> = {}): Record<string, string> {
  const tree = { ...readFixtureTree(name), ...extra };
  return Object.fromEntries(Object.entries(tree).map(([path, value]) => [path, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`]));
}

function storesFor(workspaceId: string): WorkspaceStores {
  const dir = mkdtempSync(join(tmpdir(), 'lousho-runtime-'));
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

const ZERO: PageUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

const SAMPLE: Record<string, unknown> = { string: 'text', number: 1, integer: 1, boolean: true, array: [], object: {} };

function sampleOutput(schema: unknown): Record<string, unknown> {
  const { properties = {}, required = [] } = (typeof schema === 'object' && schema !== null ? schema : {}) as { properties?: Record<string, { type?: string }>; required?: string[] };
  return Object.fromEntries(required.map((key) => [key, SAMPLE[properties[key]?.type ?? 'string']]));
}

interface FakeOptions {
  usage?: (pageId: string) => PageUsage;
  hold?: Promise<void>;
  entered?: (revision: string) => void;
  waitForAbort?: boolean;
}

function fakeEngines(options: FakeOptions = {}): EngineRegistry {
  const factory: PageEngineFactory = (setup) => {
    const engine: PageEngine = {
      type: setup.page.execution.type,
      async run(input, ctx) {
        options.entered?.(setup.workspace.revision);
        if (options.waitForAbort) {
          await new Promise<void>((resolve) => (ctx.signal.aborted ? resolve() : ctx.signal.addEventListener('abort', () => resolve(), { once: true })));
          return { status: 'cancelled', artifacts: [], summary: 'stopped', usage: ZERO, runId: ctx.runId, error: { kind: 'cancelled', message: 'stopped' } };
        }
        await options.hold;
        for (const artifact of setup.harness.outputs?.artifacts ?? []) await ctx.artifacts.put(artifact.name, 'bytes', artifact.mediaType);
        return { status: 'ok', output: sampleOutput(setup.harness.outputs?.schema), artifacts: [], summary: `made ${input.pageId}`, usage: options.usage?.(input.pageId) ?? ZERO, runId: ctx.runId };
      },
    };
    return engine;
  };
  return { single: factory, workflow: factory, 'multi-agent': factory, 'goal-oriented': factory };
}

async function collect(events: AsyncIterable<WorkspaceRunEvent>): Promise<WorkspaceRunEvent[]> {
  const all: WorkspaceRunEvent[] = [];
  for await (const event of events) all.push(event);
  return all;
}

const routeTo = (page: string, task: string, inputs?: unknown): Exclude<MockTurn, string> => ({ toolCalls: [{ name: `run_page_${page}`, args: { task, ...(inputs !== undefined && { inputs }) } }] });

const triage = (task = 'Rank this report.'): Omit<PageInput, 'pageId'> => ({ task, inputs: { report: 'The site is down.' } });

function marketingOnTwoProviders(): Record<string, string> {
  const tree = readFixtureTree('marketing') as Record<string, unknown>;
  const page = (id: string) => tree[`pages/${id}/page.json`] as Record<string, unknown>;
  const agents = tree['pages/instagram-videos/agents.json'] as { agents: Record<string, unknown>[] };
  return files('marketing', {
    'pages/instagram-videos/page.json': { ...page('instagram-videos'), execution: { type: 'single', single: { agent: 'script' } } },
    'pages/instagram-videos/agents.json': { ...agents, agents: agents.agents.map((agent) => (agent.as === 'script' ? { ...agent, model: 'mock-a/m' } : agent)) },
    'pages/facebook-videos/page.json': { ...page('facebook-videos'), defaults: { model: 'mock-b/m' }, execution: { type: 'single', single: { agent: 'script' } } },
  });
}

describe('createWorkspaceRuntime', () => {
  it('instagram runs on provider A and facebook on provider B (two mock providers)', async () => {
    const reply = mockModel(['{"script":"A script."}'], { onExhausted: 'repeat-last' });
    const a = mockModel(['{"script":"A script."}'], { onExhausted: 'repeat-last' });
    const b = mockModel(['{"script":"B script."}'], { onExhausted: 'repeat-last' });
    const runtime = createWorkspaceRuntime(memorySource(marketingOnTwoProviders()), testHost('marketing', { 'mock-a/m': a, 'mock-b/m': b, 'mock/mock-model': reply }));
    await runtime.runPage('instagram-videos', { task: 'A video about tea', inputs: { topic: 'tea' } });
    expect(a.calls.length).toBeGreaterThan(0);
    expect(b.calls).toHaveLength(0);
    const before = a.calls.length;
    await runtime.runPage('facebook-videos', { task: 'A video about tea', inputs: { topic: 'tea' } });
    expect(b.calls.length).toBeGreaterThan(0);
    expect(a.calls).toHaveLength(before);
    expect(reply.calls).toHaveLength(0);
    await runtime.close();
  });

  it('runPage records a note in the thread', async () => {
    const main = mockModel(['I see the triage run.']);
    const host = testHost('coding', { 'mock/mock-model': main }, { engines: fakeEngines() });
    const runtime = createWorkspaceRuntime(memorySource(files('coding')), host);
    const result = await runtime.runPage('support-triage', triage(), { threadId: 'thread-1', runId: 'direct-1' });
    expect(result.status).toBe('ok');
    const thread = (await host.stores.threads.load('thread-1')) ?? [];
    expect(thread).toHaveLength(1);
    expect(String(thread[0].content)).toContain("Page 'support-triage' run direct-1 ended ok.");
    await collect(runtime.run('What did the triage say?', { threadId: 'thread-1' }));
    expect(main.calls[0].messages.some((message) => String(message.content).includes('run direct-1'))).toBe(true);
    await runtime.close();
  });

  it('cancel aborts the running page', async () => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => (entered = resolve));
    const host = testHost('coding', {}, { engines: fakeEngines({ waitForAbort: true, entered: () => entered() }) });
    const runtime = createWorkspaceRuntime(memorySource(files('coding')), host);
    const running = runtime.runPage('support-triage', triage(), { runId: 'run-c' });
    await started;
    expect(runtime.cancel('run-c')).toBe(true);
    const result = await running;
    expect(result.status).toBe('cancelled');
    expect((await host.stores.runs.get('run-c'))?.status).toBe('cancelled');
    expect(runtime.cancel('run-c')).toBe(false);
    await runtime.close();
  });

  it('usage sums per page', async () => {
    const usage = (pageId: string): PageUsage => (pageId === 'instagram-videos' ? { inputTokens: 10, outputTokens: 5, totalTokens: 15 } : { inputTokens: 20, outputTokens: 10, totalTokens: 30 });
    const main = mockModel([
      { ...routeTo('instagram-videos', 'Tea for Instagram', { topic: 'tea' }), usage: { inputTokens: 3, outputTokens: 1 } },
      { ...routeTo('facebook-videos', 'Tea for Facebook', { topic: 'tea' }), usage: { inputTokens: 3, outputTokens: 1 } },
      { text: 'Both are ready.', usage: { inputTokens: 3, outputTokens: 1 } },
    ]);
    const host = testHost('marketing', { 'mock/mock-model': main }, { engines: fakeEngines({ usage }) });
    const runtime = createWorkspaceRuntime(memorySource(files('marketing')), host);
    const events = await collect(runtime.run('Make tea videos for both channels', { threadId: 'thread-u', runId: 'ws-1' }));
    expect(events[0]).toMatchObject({ type: 'started', runId: 'ws-1', threadId: 'thread-u' });
    const finished = events.at(-1);
    if (finished?.type !== 'finished') throw new Error('the run did not finish');
    expect(finished.status).toBe('ok');
    expect(finished.pages.map((page) => [page.pageId, page.usage.totalTokens])).toEqual([
      ['instagram-videos', 15],
      ['facebook-videos', 30],
    ]);
    const own = finished.turn.kind === 'main' ? finished.turn.usage : ZERO;
    expect(own.totalTokens).toBe(12);
    expect(finished.usage).toMatchObject({ inputTokens: 39, outputTokens: 18, totalTokens: 57 });
    const pageEvents = events.filter((event) => event.type === 'page');
    expect(pageEvents.filter((event) => event.event.type === 'finished').map((event) => event.event.type === 'finished' && event.event.usage?.totalTokens)).toEqual([15, 30]);
    expect((await host.stores.runs.get('ws-1'))?.status).toBe('ok');
    await runtime.close();
  });

  it('a missing stores.threads fails construction naming the field', () => {
    const host = testHost('coding', {});
    const { threads: _threads, ...stores } = host.stores;
    expect(() => createWorkspaceRuntime(memorySource(files('coding')), { ...host, stores: stores as WorkspaceHost['stores'] })).toThrow(
      expect.objectContaining({ code: 'LOUSHO_WORKSPACE_HOST_INVALID', message: expect.stringContaining('host.stores.threads') })
    );
  });

  it('a run started before a write uses the old revision to the end', async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    const seen: string[] = [];
    let entered!: () => void;
    const started = new Promise<void>((resolve) => (entered = resolve));
    const source: WorkspaceSource = memorySource(files('coding'));
    const host = testHost('coding', {}, { engines: fakeEngines({ hold, entered: (revision) => (seen.push(revision), entered()) }) });
    const runtime = createWorkspaceRuntime(source, host);
    const old = await source.revision();
    const running = runtime.runPage('support-triage', triage(), { runId: 'pinned' });
    await started;
    const write = await source.write?.({ 'pages/support-triage/resources/extra.md': 'More notes.\n' }, { expectedRevision: old, by: 'person:test', message: 'add notes' });
    release();
    await running;
    expect(seen).toEqual([old]);
    expect((await host.stores.runs.get('pinned'))?.revision).toBe(old);
    await runtime.runPage('support-triage', triage(), { runId: 'after' });
    expect(seen[1]).toBe(write?.revision);
    expect((await host.stores.runs.get('after'))?.revision).toBe(write?.revision);
    await runtime.close();
  });
});

describe('the workspace runtime host', () => {
  it('a pageId turn streams started, the page events and finished, and a closed runtime refuses runs', async () => {
    const runtime = createWorkspaceRuntime(memorySource(files('coding')), testHost('coding', { 'mock/mock-model': mockModel([]) }, { engines: fakeEngines() }));
    const events = await collect(runtime.run('Rank it', { threadId: 'thread-p', pageId: 'support-triage', inputs: { report: 'Down.' } }));
    expect(events.map((event) => (event.type === 'page' ? `page.${event.event.type}` : event.type))).toEqual(['started', 'page.started', 'page.finished', 'finished']);
    await runtime.close();
    expect(() => runtime.run('again', { threadId: 'thread-p' })).toThrow(expect.objectContaining({ code: 'LOUSHO_WORKSPACE_RUNTIME_CLOSED' }));
  });

  it('explain gives the effective harness hash at the current revision', async () => {
    const source = memorySource(files('coding'));
    const runtime = createWorkspaceRuntime(source, testHost('coding', {}));
    const explained = await runtime.explain('support-triage');
    expect(explained.revision).toBe(await source.revision());
    expect(explained.text).toContain(`Effective harness ${explained.hash}`);
    await runtime.close();
  });

  it('a tool the host binds sees only the secrets its scope grants, and an unbound tool cannot be sandboxed', async () => {
    const descriptor = defineTool({ name: 'deploy', description: 'Deploys.', input: z.object({}), execute: () => 'ok' });
    const scope: PageToolScope = { name: 'deploy', page: 'fix', attachment: 'agent', secrets: [{ env: 'GRANTED' }], network: { allowHosts: [] }, sandbox: { required: false } };
    let values: (string | undefined)[] = [];
    const host = testHost('coding', {}, {
      secrets: { resolve: async (ref) => ('env' in ref ? `value-of-${ref.env}` : undefined) },
      bindTool: (tool, _scope, secrets) => {
        void Promise.all([secrets.resolve({ env: 'GRANTED' }), secrets.resolve({ env: 'OTHER' })]).then((found) => (values = found));
        return tool;
      },
    });
    expect(pageHostOf(host).bindTool(descriptor, scope)).toBe(descriptor);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(values).toEqual(['value-of-GRANTED', undefined]);
    const unbound = pageHostOf(testHost('coding', {}));
    expect(unbound.bindTool(descriptor, scope)).toBe(descriptor);
    expect(() => unbound.bindTool(descriptor, { ...scope, sandbox: { required: true } })).toThrow(expect.objectContaining({ code: 'LOUSHO_WORKSPACE_HOST_INVALID' }));
    expect(() => unbound.provider?.(undefined)).toThrow(expect.objectContaining({ code: 'LOUSHO_CONFIG_MISSING_PROVIDER' }));
  });
});
