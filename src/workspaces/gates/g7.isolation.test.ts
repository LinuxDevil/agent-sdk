import { z } from 'zod';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defineTool } from '../../tools/defineTool';
import { defineMemory } from '../../memory/defineMemory';
import { inMemoryMemory } from '../../memory/providers';
import { mockModel, type MockTurn } from '../../testing';
import type { LLMProvider } from '../../providers';
import { readFixtureTree } from '../__fixtures__/readTree';
import type { PageEngine, PageResult } from '../contracts/execution';
import type { WorkspacePolicy } from '../contracts/policy';
import { memorySource } from '../source/memorySource';
import { memoryArtifactStore } from '../runtime/artifacts';
import { fileHostBackend } from '../runtime/backends';
import { singleEngine } from '../runtime/engines/single';
import type { EngineRegistry, PageEngineFactory, PageEngineSetup } from '../runtime/engines/types';
import { createWorkspaceStores, type WorkspaceStores } from '../runtime/stores';
import type { WorkspaceHost } from '../runtime/workspaceHost';
import { createWorkspaceRuntime, type WorkspaceRunEvent } from '../runtime/workspaceRuntime';

const CEILING: WorkspacePolicy = { permissions: [], tools: { allow: ['*'] }, secrets: [] };
const MARKER = 'IG-SECRET-42';
const FACEBOOK_BYTES = 'facebook-video-bytes';
const SCOPE_KEY = 'shared';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function files(extra: Record<string, unknown>): Record<string, string> {
  const tree = { ...readFixtureTree('marketing'), ...extra };
  return Object.fromEntries(Object.entries(tree).map(([path, value]) => [path, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`]));
}

function marketingFiles(limits?: { maxDurationMs: number }): Record<string, string> {
  const tree = readFixtureTree('marketing') as Record<string, unknown>;
  const facebook = tree['pages/facebook-videos/page.json'] as Record<string, unknown>;
  const agents = tree['pages/facebook-videos/agents.json'] as { agents: Record<string, unknown>[] };
  const instagram = tree['pages/instagram-videos/page.json'] as Record<string, unknown>;
  const instagramAgents = tree['pages/instagram-videos/agents.json'] as { agents: Record<string, unknown>[] };
  return files({
    'pages/instagram-videos/page.json': { ...instagram, defaults: { model: 'mock-a/m' }, execution: { type: 'single', single: { agent: 'video' }, ...(limits && { limits }) } },
    'pages/instagram-videos/agents.json': { ...instagramAgents, agents: instagramAgents.agents.map((agent) => (agent.as === 'video' ? { ...agent, model: 'mock-a/m' } : agent)) },
    'pages/facebook-videos/page.json': { ...facebook, defaults: { model: 'mock-b/m' }, execution: { type: 'single', single: { agent: 'script' } } },
    'pages/facebook-videos/agents.json': { ...agents, agents: agents.agents.map((agent) => (agent.as === 'script' ? { ...agent, model: 'mock-b/m' } : agent)) },
    'shared/memory/notes.ts': 'export default {}',
  });
}

function storesFor(): WorkspaceStores {
  const dir = mkdtempSync(join(tmpdir(), 'lousho-g7-'));
  dirs.push(dir);
  return createWorkspaceStores(fileHostBackend(dir), { projectId: 'proj-1', workspaceId: 'marketing' });
}

function hostFor(providers: Record<string, LLMProvider>, engines: EngineRegistry, memory: ReturnType<typeof inMemoryMemory>): WorkspaceHost & { stores: WorkspaceStores } {
  let next = 0;
  return {
    tools: { render_video: { descriptor: renderVideo } },
    bindTool: (tool) => tool,
    policyCeiling: CEILING,
    providers: {
      resolve(ref) {
        const provider = providers[ref];
        if (!provider) throw new Error(`no provider for ${ref}`);
        return provider;
      },
    },
    secrets: { resolve: async () => undefined },
    stores: { ...storesFor(), artifacts: memoryArtifactStore() },
    globals: { agents: { resolve: async () => undefined }, profiles: { get: (ref) => { throw new Error(`no global profile ${ref}`); } } },
    newRunId: () => `run-${++next}`,
    createMemory: (file) => defineMemory({ name: file.name, scope: 'global', provider: memory }),
    engines,
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

function notesOf(setup: PageEngineSetup): ReturnType<typeof inMemoryMemory> {
  const slot = setup.shared.memorySlots[0]?.slot;
  if (!slot) throw new Error('the page has no shared memory slot');
  return slot.provider as ReturnType<typeof inMemoryMemory>;
}

interface Scenario {
  turns: MockTurn[];
  limits?: { maxDurationMs: number };
  status: PageResult['status'];
  kind: string;
  toolError?: true;
}

const scenarios: Record<string, Scenario> = {
  'a host tool throws inside the single engine and the model cannot recover': { turns: [{ toolCalls: [{ name: 'render_video', args: {} }] }, 'I could not render the video.'], status: 'failed', kind: 'invalid-output', toolError: true },
  'the page exceeds maxDurationMs (a real timeout)': { turns: [{ text: '{"script":"late"}', delayMs: 2000 }], limits: { maxDurationMs: 50 }, status: 'timed-out', kind: 'timeout' },
  'the page returns invalid output': { turns: ['{"script":5}'], status: 'failed', kind: 'invalid-output' },
};

const renderVideo = defineTool({
  name: 'render_video',
  description: 'Renders the video.',
  input: z.object({}),
  execute: () => {
    throw new Error('render_video crashed');
  },
});

function instagramFactory(settled: () => void, attempts: { count: number }): PageEngineFactory {
  return (setup) => {
    const inner = singleEngine(setup);
    const engine: PageEngine = {
      type: 'single',
      async run(input, ctx) {
        attempts.count += 1;
        await notesOf(setup).add(SCOPE_KEY, { text: `instagram note ${attempts.count}` });
        await ctx.artifacts.put('video', `instagram partial ${MARKER}`, 'video/mp4');
        try {
          return await inner.run(input, ctx);
        } finally {
          settled();
        }
      },
    };
    return engine;
  };
}

function facebookFactory(afterInstagram: Promise<void>): PageEngineFactory {
  return (setup) => {
    const inner = singleEngine(setup);
    const engine: PageEngine = {
      type: 'single',
      async run(input, ctx) {
        await notesOf(setup).add(SCOPE_KEY, { text: 'facebook note before' });
        await afterInstagram;
        await sleep(5);
        await ctx.artifacts.put('video', FACEBOOK_BYTES, 'video/mp4');
        await notesOf(setup).add(SCOPE_KEY, { text: 'facebook note after' });
        return inner.run(input, ctx);
      },
    };
    return engine;
  };
}

async function collect(events: AsyncIterable<WorkspaceRunEvent>): Promise<WorkspaceRunEvent[]> {
  const all: WorkspaceRunEvent[] = [];
  for await (const event of events) all.push(event);
  return all;
}

type Mode = 'two concurrent runPage calls' | 'two routed calls in one main-agent turn';

interface Landed {
  instagram: PageResult;
  facebook: PageResult;
}

async function launch(runtime: ReturnType<typeof createWorkspaceRuntime>, mode: Mode): Promise<Landed> {
  const inputs = { topic: 'tea' };
  if (mode === 'two concurrent runPage calls') {
    const [instagram, facebook] = await Promise.all([
      runtime.runPage('instagram-videos', { task: `A video about tea ${MARKER}`, inputs }, { threadId: 'thread-g7', runId: 'ig-run' }),
      runtime.runPage('facebook-videos', { task: 'A video about tea', inputs }, { threadId: 'thread-g7', runId: 'fb-run' }),
    ]);
    return { instagram, facebook };
  }
  const events = await collect(runtime.run('Make tea videos for both channels', { threadId: 'thread-g7' }));
  const finished = events.at(-1);
  if (finished?.type !== 'finished' || finished.turn.kind !== 'main') throw new Error('the main agent did not finish');
  const resultOf = (pageId: string): PageResult => {
    const record = finished.turn.kind === 'main' ? finished.turn.runs.find((run) => run.pageId === pageId) : undefined;
    if (!record) throw new Error(`page ${pageId} did not run`);
    return record.result;
  };
  return { instagram: resultOf('instagram-videos'), facebook: resultOf('facebook-videos') };
}

const MODES: Mode[] = ['two concurrent runPage calls', 'two routed calls in one main-agent turn'];

describe('G7: a page failure does not corrupt another page', () => {
  const cases = Object.keys(scenarios).flatMap((scenario) => MODES.map((mode) => [scenario, mode] as const));

  it.each(cases)('when %s in the Instagram page, via %s, the Facebook page is untouched', async (name, mode) => {
    const scenario = scenarios[name] as Scenario;
    const afterInstagram = deferred();
    const attempts = { count: 0 };
    const memory = inMemoryMemory();
    const facebookModel = mockModel(['{"script":"B script."}'], { onExhausted: 'repeat-last' });
    const instagramModel = mockModel(scenario.turns, { onExhausted: 'repeat-last' });
    const routing: MockTurn[] = [
      { toolCalls: [{ name: 'run_page_instagram-videos', args: { task: `A video about tea ${MARKER}`, inputs: { topic: 'tea' } } }, { name: 'run_page_facebook-videos', args: { task: 'A video about tea', inputs: { topic: 'tea' } } }] },
      'Noted the results.',
    ];
    const main = mockModel(mode === 'two concurrent runPage calls' ? ['Noted the results.'] : routing);
    const engines: EngineRegistry = {
      single: (setup) => (setup.page.id === 'instagram-videos' ? instagramFactory(afterInstagram.resolve, attempts)(setup) : facebookFactory(afterInstagram.promise)(setup)),
    };
    const host = hostFor({ 'mock/mock-model': main, 'mock-a/m': instagramModel, 'mock-b/m': facebookModel }, engines, memory);
    const runtime = createWorkspaceRuntime(memorySource(marketingFiles(scenario.limits)), host);

    const { instagram, facebook } = await launch(runtime, mode);
    expect(attempts.count).toBeGreaterThan(0);
    if (scenario.toolError) expect(JSON.stringify(instagramModel.calls)).toContain('render_video crashed');

    expect(instagram.status).toBe(scenario.status);
    expect(instagram.error?.kind).toBe(scenario.kind);
    expect(facebook.status).toBe('ok');
    expect(facebook.error).toBeUndefined();
    expect((await host.stores.runs.get(instagram.runId))?.status).toBe(scenario.status);
    expect((await host.stores.runs.get(facebook.runId))?.status).toBe('ok');

    expect(facebook.output).toEqual({ script: 'B script.' });
    expect(facebook.artifacts).toHaveLength(1);
    const [video] = facebook.artifacts;
    expect(video.sha256).toBe(sha(FACEBOOK_BYTES));
    expect(video.uri).toContain(facebook.runId);
    const stored = await host.stores.artifacts.get(video.uri, { workspace: 'marketing', runId: facebook.runId });
    expect(new TextDecoder().decode(stored?.data)).toBe(FACEBOOK_BYTES);
    expect(createHash('sha256').update(stored?.data ?? new Uint8Array()).digest('hex')).toBe(video.sha256);

    const seenByFacebook = JSON.stringify(facebookModel.calls);
    expect(seenByFacebook).not.toContain(MARKER);
    expect(seenByFacebook).not.toContain('instagram partial');
    expect(seenByFacebook).not.toContain('render_video crashed');

    const notes = (await memory.list(SCOPE_KEY)).map((item) => item.text);
    expect(notes).toContain('facebook note before');
    expect(notes).toContain('facebook note after');
    expect(notes).toContain('instagram note 1');

    const thread = (await host.stores.threads.load('thread-g7')) ?? [];
    const noteFor = (page: string): string => thread.map((message) => String(message.content)).find((text) => text.includes(`Page '${page}'`)) ?? '';
    expect(noteFor('instagram-videos')).toContain(`ended ${scenario.status}.`);
    expect(noteFor('instagram-videos')).toContain(`error (${scenario.kind}):`);
    expect(noteFor('facebook-videos')).toContain('ended ok.');
    expect(noteFor('facebook-videos')).not.toContain('error (');

    if (mode === 'two concurrent runPage calls') await collect(runtime.run('What happened to the runs?', { threadId: 'thread-g7' }));
    const sent = main.calls.at(-1)?.messages.map((message) => String(message.content)).join('\n') ?? '';
    expect(sent).toContain(`Page 'instagram-videos' run ${instagram.runId} ended ${scenario.status}.`);
    expect(sent).toContain(`Page 'facebook-videos' run ${facebook.runId} ended ok.`);
    await runtime.close();
  });
});
