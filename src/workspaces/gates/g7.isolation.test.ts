import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defineMemory } from '../../memory/defineMemory';
import { inMemoryMemory } from '../../memory/providers';
import { mockModel } from '../../testing';
import type { LLMProvider } from '../../providers';
import { readFixtureTree } from '../__fixtures__/readTree';
import type { PageEngine, PageResult, PageUsage } from '../contracts/execution';
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
const ZERO: PageUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
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

function marketingFiles(): Record<string, string> {
  const tree = readFixtureTree('marketing') as Record<string, unknown>;
  const facebook = tree['pages/facebook-videos/page.json'] as Record<string, unknown>;
  const agents = tree['pages/facebook-videos/agents.json'] as { agents: Record<string, unknown>[] };
  return files({
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

type InstagramFailure = (setup: PageEngineSetup, runId: string, attempt: number) => Promise<PageResult>;

const failures: Record<string, InstagramFailure> = {
  'throws in a tool': async () => {
    throw new Error('render_video crashed');
  },
  'times out': async (_setup, runId) => {
    await sleep(20);
    return { status: 'timed-out', artifacts: [], summary: 'ran out of time', usage: ZERO, runId, error: { kind: 'timeout', message: 'the page ran out of time' } };
  },
  'returns invalid output': async (_setup, runId) => ({ status: 'ok', output: { script: 5 }, artifacts: [], summary: 'done', usage: ZERO, runId }),
};

function instagramFactory(failure: InstagramFailure, settled: () => void, attempts: { count: number }): PageEngineFactory {
  return (setup) => {
    const engine: PageEngine = {
      type: 'workflow',
      async run(_input, ctx) {
        attempts.count += 1;
        await notesOf(setup).add(SCOPE_KEY, { text: `instagram note ${attempts.count}` });
        await ctx.artifacts.put('video', `instagram partial ${MARKER}`, 'video/mp4');
        try {
          return await failure(setup, ctx.runId, attempts.count);
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

describe('G7: a page failure does not corrupt another page', () => {
  it.each(Object.keys(failures))('the Instagram page %s while the Facebook page runs concurrently', async (scenario) => {
    const afterInstagram = deferred();
    const attempts = { count: 0 };
    const memory = inMemoryMemory();
    const facebookModel = mockModel(['{"script":"B script."}'], { onExhausted: 'repeat-last' });
    const main = mockModel(['Noted, Instagram needs another try.']);
    const engines: EngineRegistry = {
      single: facebookFactory(afterInstagram.promise),
      workflow: instagramFactory(failures[scenario] as InstagramFailure, afterInstagram.resolve, attempts),
    };
    const host = hostFor({ 'mock/mock-model': main, 'mock-b/m': facebookModel }, engines, memory);
    const runtime = createWorkspaceRuntime(memorySource(marketingFiles()), host);

    const input = { topic: 'tea' };
    const [instagram, facebook] = await Promise.all([
      runtime.runPage('instagram-videos', { task: `A video about tea ${MARKER}`, inputs: input }, { threadId: 'thread-g7', runId: 'ig-run' }),
      runtime.runPage('facebook-videos', { task: 'A video about tea', inputs: input }, { threadId: 'thread-g7', runId: 'fb-run' }),
    ]);
    expect(attempts.count).toBeGreaterThan(0);

    expect(instagram.status).not.toBe('ok');
    expect(facebook.status).toBe('ok');
    expect((await host.stores.runs.get('ig-run'))?.status).not.toBe('ok');
    expect((await host.stores.runs.get('fb-run'))?.status).toBe('ok');

    expect(facebook.output).toEqual({ script: 'B script.' });
    expect(facebook.artifacts).toHaveLength(1);
    const [video] = facebook.artifacts;
    expect(video.sha256).toBe(sha(FACEBOOK_BYTES));
    expect(video.uri).toContain('fb-run');
    const stored = await host.stores.artifacts.get(video.uri, { workspace: 'marketing', runId: 'fb-run' });
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
    expect(noteFor('instagram-videos')).toMatch(/ended (failed|timed-out)\./);
    expect(noteFor('instagram-videos')).toMatch(/error \((engine|timeout|invalid-output)\):/);
    expect(noteFor('facebook-videos')).toContain('ended ok.');
    expect(noteFor('facebook-videos')).not.toContain('error (');

    await collect(runtime.run('What happened to the runs?', { threadId: 'thread-g7' }));
    const sent = main.calls[0].messages.map((message) => String(message.content)).join('\n');
    expect(sent).toContain("Page 'instagram-videos' run ig-run ended");
    expect(sent).toContain("Page 'facebook-videos' run fb-run ended ok.");
    await runtime.close();
  });
});
