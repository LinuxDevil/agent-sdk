import { AsyncLocalStorage } from 'node:async_hooks';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineMemory } from '../../memory/defineMemory';
import { inMemoryMemory } from '../../memory/providers';
import type { MemoryProvider } from '../../memory/defineMemory';
import type { LLMProvider } from '../../providers';
import { mockModel, type MockModel, type MockRequest, type MockStaticTurn } from '../../testing';
import { defineTool } from '../../tools/defineTool';
import type { ToolDescriptor } from '../../types';
import {
  blobArtifactStore,
  createWorkspaceRuntime,
  createWorkspaceStores,
  ENGINES,
  fileArtifactStore,
  memoryBlobClient,
  memorySource,
  sqliteHostBackend,
  sqliteSqlClient,
  sqliteWorkspaceSource,
  type ArtifactSink,
  type BlobClient,
  type EngineRegistry,
  type HostBackend,
  type PageEngineFactory,
  type PageResult,
  type PageToolScope,
  type SqlClient,
  type WorkspaceHost,
  type WorkspaceRunEvent,
  type WorkspaceRuntime,
  type WorkspaceSource,
  type WorkspaceStores,
} from '../index';

const fsTrap = vi.hoisted(() => {
  const calls: string[] = [];
  const thrower = (module: string, name: string) =>
    function trapped(...args: unknown[]): never {
      calls.push(`${module}.${name}(${String(args[0])})`);
      throw new Error(`G9: ${module}.${name} was called; an embedded host has no filesystem`);
    };
  const isTrappable = (name: string, value: unknown): boolean => typeof value === 'function' && !/^[A-Z]/.test(name);
  const wrapAll = (module: string, target: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(Object.entries(target).map(([name, value]) => [name, isTrappable(name, value) ? thrower(module, name) : value]));
  const trap = (module: string, actual: Record<string, unknown>): Record<string, unknown> => {
    const top = wrapAll(module, actual);
    const promises = actual.promises as Record<string, unknown> | undefined;
    return { ...top, ...(promises && { promises: wrapAll(`${module}.promises`, promises) }), default: top };
  };
  return { calls, trap };
});

vi.mock('node:fs', async (importOriginal) => fsTrap.trap('node:fs', await importOriginal()));
vi.mock('fs', async (importOriginal) => fsTrap.trap('fs', await importOriginal()));
vi.mock('node:fs/promises', async (importOriginal) => fsTrap.trap('node:fs/promises', await importOriginal()));
vi.mock('fs/promises', async (importOriginal) => fsTrap.trap('fs/promises', await importOriginal()));

const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../..');
const MARKETING_DIR = join(REPO, 'examples/workspace-marketing/workspace');
const OPS_DESK_DIR = join(REPO, 'src/workspaces/__fixtures__/ops-desk');
const MODEL = 'mock/mock-model';
const PROJECT = 'g9-host';
const SECRET = 'marketing-only-note-7f3a';
const CEILING = { permissions: [], tools: { allow: ['*'] }, secrets: [] };
const MEMORY_FILE = 'shared/memory/notes.ts';
const MEMORY_SOURCE = "export default { description: 'Notes the workspace keeps between runs.' };\n";

function walk(root: string, prefix = ''): string[] {
  return realFs.readdirSync(join(root, prefix), { withFileTypes: true }).flatMap((entry) => {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    return entry.isDirectory() ? walk(root, path) : [path];
  });
}

function readTree(root: string): Record<string, string> {
  return Object.fromEntries(walk(root).sort().map((path) => [path, realFs.readFileSync(join(root, path), 'utf8')]));
}

const asJson = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

function marketingFiles(): Record<string, string> {
  return { ...readTree(MARKETING_DIR), [MEMORY_FILE]: MEMORY_SOURCE };
}

function opsDeskFiles(): Record<string, string> {
  const files = readTree(OPS_DESK_DIR);
  const page = JSON.parse(files['pages/reply-drafts/page.json']) as Record<string, unknown>;
  const agents = JSON.parse(files['pages/reply-drafts/agents.json']) as { agents: { as: string }[] };
  return {
    ...files,
    'pages/reply-drafts/page.json': asJson({ ...page, execution: { type: 'single', single: { agent: 'drafter' } } }),
    'pages/reply-drafts/agents.json': asJson({ ...agents, agents: agents.agents.filter((agent) => agent.as === 'drafter') }),
    [MEMORY_FILE]: MEMORY_SOURCE,
  };
}

const toolNames = (request: MockRequest): string[] => (request.tools ?? []).map((tool) => tool.function.name);
const toolResults = (request: MockRequest): number => request.messages.filter((message) => message.role === 'tool').length;
const routeTo = (page: string): MockStaticTurn => ({ toolCalls: [{ name: `run_page_${page}`, args: { task: `Make the ${page} video.`, inputs: { topic: 'tea' } } }] });

const MAIN_TURNS: readonly MockStaticTurn[] = [routeTo('instagram-videos'), routeTo('facebook-videos'), 'Both videos are ready.'];

function marketingPageTurn(request: MockRequest): MockStaticTurn {
  const script = 'Three quick facts about tea.';
  const steps: MockStaticTurn[] = [
    { toolCalls: [{ name: 'render_video', args: { script } }] },
    { toolCalls: [{ name: 'synthesize_voice', args: { script } }] },
    { toolCalls: [{ name: 'remember_notes', args: { text: SECRET } }] },
  ];
  return steps[toolResults(request)] ?? JSON.stringify({ script });
}

function marketingModel(): MockModel {
  const turn = (request: MockRequest): MockStaticTurn =>
    toolNames(request).some((name) => name.startsWith('run_page_')) ? (MAIN_TURNS[toolResults(request)] ?? 'Done.') : marketingPageTurn(request);
  return mockModel([turn], { onExhausted: 'repeat-last' });
}

const OPS_DESK_OUTPUTS: readonly [RegExp, Record<string, string>][] = [
  [/"request"/, { ticket: 'A ticket.' }],
  [/"notes"/, { digest: 'A digest.' }],
  [/"message"/, { reply: 'A reply.' }],
];

function lastUserText(request: MockRequest): string {
  const user = [...request.messages].reverse().find((message) => message.role === 'user');
  return typeof user?.content === 'string' ? user.content : '';
}

function opsDeskModel(): MockModel {
  const turn = (request: MockRequest): MockStaticTurn => JSON.stringify(OPS_DESK_OUTPUTS.find(([pattern]) => pattern.test(lastUserText(request)))?.[1] ?? {});
  return mockModel([turn], { onExhausted: 'repeat-last' });
}

const currentSink = new AsyncLocalStorage<ArtifactSink>();

function withRunSink(factory: PageEngineFactory): PageEngineFactory {
  return (setup) => {
    const engine = factory(setup);
    return { type: engine.type, run: (input, ctx) => currentSink.run(ctx.artifacts, () => engine.run(input, ctx)) };
  };
}

function artifactTool(name: string, artifact: string, mediaType: string): ToolDescriptor {
  return defineTool({
    name,
    description: `Mock: stores placeholder bytes as the run's ${artifact} artifact.`,
    input: z.object({ script: z.string() }),
    execute: async ({ script }) => {
      const sink = currentSink.getStore();
      if (!sink) throw new Error(`${name} ran outside a page run`);
      const ref = await sink.put(artifact, `placeholder ${artifact} for: ${script}`, mediaType);
      return { artifact: ref.name, bytes: ref.bytes };
    },
  });
}

const searchFacts = defineTool({ name: 'search_facts', description: 'Mock fact search.', input: z.object({ query: z.string() }), execute: ({ query }) => ({ fact: `a fact about ${query}` }) });

function bindMock(descriptor: ToolDescriptor, scope: PageToolScope): ToolDescriptor {
  if (scope.secrets.length > 0) throw new Error(`mock tool '${scope.name}' was granted secrets`);
  return descriptor;
}

interface SharedInfra {
  backend: HostBackend;
  blobs: BlobClient;
  memory: MemoryProvider;
}

type EmbedHost = WorkspaceHost & { stores: WorkspaceStores & WorkspaceHost['stores'] };

function embedHost(workspaceId: string, provider: LLMProvider, infra: SharedInfra): EmbedHost {
  const engines: EngineRegistry = Object.fromEntries(Object.entries(ENGINES).map(([type, factory]) => [type, withRunSink(factory)]));
  return {
    tools: {
      render_video: { descriptor: artifactTool('render_video', 'video', 'video/mp4') },
      synthesize_voice: { descriptor: artifactTool('synthesize_voice', 'voice', 'audio/mpeg') },
      search_facts: { descriptor: searchFacts },
    },
    policyCeiling: CEILING,
    providers: {
      resolve: (ref) => {
        if (ref !== MODEL) throw new Error(`the host does not allow ${ref}`);
        return provider;
      },
    },
    secrets: { resolve: async () => undefined },
    stores: { ...createWorkspaceStores(infra.backend, { projectId: PROJECT, workspaceId }), artifacts: blobArtifactStore(infra.blobs) },
    globals: {
      agents: { resolve: async () => undefined },
      profiles: {
        get: (ref) => {
          throw new Error(`no global profile ${ref}`);
        },
      },
    },
    bindTool: bindMock,
    createMemory: (file) => defineMemory({ name: file.name, description: 'Workspace notes.', scope: () => `workspace:${workspaceId}`, provider: infra.memory, recall: { onSessionStart: true, query: 'none' } }),
    engines,
  };
}

interface Embedded {
  marketing: { runtime: WorkspaceRuntime; host: EmbedHost; model: MockModel };
  opsDesk: { runtime: WorkspaceRuntime; host: EmbedHost; model: MockModel };
  close(): Promise<void>;
}

interface SourceKind {
  name: string;
  open(): Promise<{ sources: (workspaceId: string, files: Record<string, string>) => Promise<WorkspaceSource>; backend: HostBackend; close(): Promise<void> }>;
}

const memoryKind: SourceKind = {
  name: 'in-memory source',
  async open() {
    const backend = await sqliteHostBackend(':memory:');
    return { sources: async (_id, files) => memorySource(files), backend, close: () => backend.close() };
  },
};

const sqliteKind: SourceKind = {
  name: 'SQLite database source',
  async open() {
    const client: SqlClient = sqliteSqlClient(':memory:');
    const backend = await sqliteHostBackend(client);
    return {
      sources: (workspaceId, files) => sqliteWorkspaceSource(client, { ref: { projectId: PROJECT, workspaceId }, files }),
      backend,
      close: async () => {
        await backend.close();
        await client.close();
      },
    };
  },
};

async function embed(kind: SourceKind): Promise<Embedded> {
  const opened = await kind.open();
  const infra: SharedInfra = { backend: opened.backend, blobs: memoryBlobClient(), memory: inMemoryMemory() };
  const marketingModelInstance = marketingModel();
  const opsDeskModelInstance = opsDeskModel();
  const marketingHost = embedHost('marketing', marketingModelInstance, infra);
  const opsDeskHost = embedHost('ops-desk', opsDeskModelInstance, infra);
  const marketing = createWorkspaceRuntime(await opened.sources('marketing', marketingFiles()), marketingHost);
  const opsDesk = createWorkspaceRuntime(await opened.sources('ops-desk', opsDeskFiles()), opsDeskHost);
  return {
    marketing: { runtime: marketing, host: marketingHost, model: marketingModelInstance },
    opsDesk: { runtime: opsDesk, host: opsDeskHost, model: opsDeskModelInstance },
    close: async () => {
      await marketing.close();
      await opsDesk.close();
      await opened.close();
    },
  };
}

async function collect(events: AsyncIterable<WorkspaceRunEvent>): Promise<WorkspaceRunEvent[]> {
  const all: WorkspaceRunEvent[] = [];
  for await (const event of events) all.push(event);
  return all;
}

const OPS_DESK_PAGES: readonly [string, Record<string, string>][] = [
  ['ticket-intake', { request: 'The printer is down.' }],
  ['daily-digest', { notes: 'Two tickets closed.' }],
  ['reply-drafts', { message: 'When is the printer back?' }],
];

async function runOpsDesk(runtime: WorkspaceRuntime, threadId: string): Promise<PageResult[]> {
  const results: PageResult[] = [];
  for (const [pageId, inputs] of OPS_DESK_PAGES) results.push(await runtime.runPage(pageId, { task: `Run ${pageId}.`, inputs }, { threadId }));
  return results;
}

const transcriptText = (value: unknown): string => JSON.stringify(value ?? null);
const requestsText = (model: MockModel): string => JSON.stringify(model.calls);

const opened: Embedded[] = [];

afterEach(async () => {
  await Promise.all(opened.splice(0).map((embedded) => embedded.close()));
  expect(fsTrap.calls).toEqual([]);
});

describe('G9 fs stub', () => {
  it('is armed for code under src/', async () => {
    const put = fileArtifactStore(join(REPO, 'g9-never-created')).put({ workspace: 'w', runId: 'r' }, 'note', 'a', 'text/plain');
    const outcome = await put.then(
      () => 'resolved',
      (error: unknown) => String(error)
    );
    const calls = fsTrap.calls.splice(0);
    expect(outcome).toMatch(/G9: (?:node:)?fs/);
    expect(calls.length).toBeGreaterThan(0);
  });
});

describe.each([memoryKind, sqliteKind])('G9 embed in a host with no filesystem ($name)', (kind) => {
  async function start(): Promise<Embedded> {
    const embedded = await embed(kind);
    opened.push(embedded);
    return embedded;
  }

  it('Marketing runs two pages through its main agent', async () => {
    const { marketing } = await start();
    const events = await collect(marketing.runtime.run('Make tea videos for both channels.', { threadId: 'thread-1' }));
    const finished = events.at(-1);
    if (finished?.type !== 'finished') throw new Error('the Marketing run did not finish');
    expect(finished.status).toBe('ok');
    expect(finished.pages.map((page) => [page.pageId, page.status])).toEqual([
      ['instagram-videos', 'ok'],
      ['facebook-videos', 'ok'],
    ]);
    expect(fsTrap.calls).toEqual([]);
  });

  it('ops-desk runs three pages with no main agent through runPage', async () => {
    const { opsDesk } = await start();
    const results = await runOpsDesk(opsDesk.runtime, 'thread-1');
    expect(results.map((result) => result.status)).toEqual(['ok', 'ok', 'ok']);
    expect(results.map((result) => result.output)).toEqual([{ ticket: 'A ticket.' }, { digest: 'A digest.' }, { reply: 'A reply.' }]);
    const events = await collect(opsDesk.runtime.run('Route this.', { threadId: 'thread-2' }));
    expect(events.at(-1)).toMatchObject({ type: 'finished', status: 'failed' });
    expect(fsTrap.calls).toEqual([]);
  });

  it("two workspaces in one process don't share threads, artifacts or memory", async () => {
    const { marketing, opsDesk } = await start();
    await collect(marketing.runtime.run('Make tea videos for both channels.', { threadId: 'shared-thread' }));
    await runOpsDesk(opsDesk.runtime, 'shared-thread');

    const marketingThread = transcriptText(await marketing.host.stores.threads.load('shared-thread'));
    const opsDeskThread = transcriptText(await opsDesk.host.stores.threads.load('shared-thread'));
    expect(marketingThread).toContain('run_page_instagram-videos');
    expect(opsDeskThread).toContain('ticket-intake');
    expect(marketingThread).not.toContain('ticket-intake');
    expect(opsDeskThread).not.toContain('instagram-videos');
    expect((await marketing.host.stores.runs.list()).every((run) => run.workspaceId === 'marketing')).toBe(true);
    expect((await opsDesk.host.stores.runs.list()).every((run) => run.workspaceId === 'ops-desk')).toBe(true);

    const firstCallOfRerun = marketing.model.calls.length;
    const result = await marketing.runtime.runPage('instagram-videos', { task: 'Again.', inputs: { topic: 'tea' } });
    expect(JSON.stringify(marketing.model.calls[firstCallOfRerun])).toContain(SECRET);
    const video = result.artifacts.find((ref) => ref.name === 'video');
    if (!video) throw new Error('no video artifact');
    expect(await marketing.host.stores.artifacts.get(video.uri, { workspace: 'marketing', runId: result.runId })).toBeDefined();
    await expect(Promise.resolve().then(() => opsDesk.host.stores.artifacts.get(video.uri, { workspace: 'ops-desk', runId: result.runId }))).rejects.toThrow();

    expect(requestsText(opsDesk.model)).not.toContain(SECRET);
    await runOpsDesk(opsDesk.runtime, 'after-marketing');
    expect(requestsText(opsDesk.model)).not.toContain(SECRET);
    expect(fsTrap.calls).toEqual([]);
  });

  it('embedding leaves fetch and process.env untouched', async () => {
    const fetchBefore = globalThis.fetch;
    const envBefore = process.env;
    const { marketing, opsDesk } = await start();
    await collect(marketing.runtime.run('Make tea videos for both channels.', { threadId: 'thread-1' }));
    await runOpsDesk(opsDesk.runtime, 'thread-1');
    expect(globalThis.fetch).toBe(fetchBefore);
    expect(process.env).toBe(envBefore);
  });
});

const SPECIFIER = /(?:^|[^\w.$])(?:import|export)\s(?!type\s)[^'"`;]*?from\s*['"]([^'"]+)['"]|(?:^|[^\w.$])import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/gm;

function resolveLocal(from: string, spec: string): string | undefined {
  const base = resolve(dirname(from), spec);
  return [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), base.replace(/\.js$/, '.ts')].find((candidate) => /\.(ts|tsx|json)$/.test(candidate) && realFs.existsSync(candidate));
}

interface ModuleGraph {
  files: Set<string>;
  bare: Set<string>;
}

function specifiersOf(file: string): string[] {
  if (file.endsWith('.json')) return [];
  return [...realFs.readFileSync(file, 'utf8').matchAll(SPECIFIER)].map((match) => match[1] ?? match[2] ?? match[3] ?? '');
}

function moduleGraph(entries: readonly string[]): ModuleGraph {
  const graph: ModuleGraph = { files: new Set(), bare: new Set() };
  const pending = [...entries];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (graph.files.has(file)) continue;
    graph.files.add(file);
    for (const spec of specifiersOf(file)) {
      const local = spec.startsWith('.') ? resolveLocal(file, spec) : undefined;
      if (local) pending.push(local);
      else graph.bare.add(spec);
    }
  }
  return graph;
}

const R17_ALLOWED: Readonly<Record<string, string>> = {
  'source/folderSource.ts': 'folder source',
  'source/folderFs.ts': 'folder source',
  'runtime/fileArtifactStore.ts': 'file store',
  'runtime/fileLedger.ts': 'file store',
  'runtime/backends.ts': 'file store (fileHostBackend)',
};

const GREP_LIST: readonly [string, RegExp][] = [
  ['fs or path import', /from '(?:node:)?(?:fs|fs\/promises|path)'/],
  ['process.cwd', /process\.cwd\b/],
  ['process.env', /process\.env\b/],
  ['globalThis.fetch', /globalThis\.fetch\b/],
  ['registerHooks', /\bregisterHooks\b/],
  ['AsyncLocalStorage', /\bAsyncLocalStorage\b/],
  ['module-level let/var', /^(?:let|var)\s/],
  ['module-level mutable collection', /^const \w+ = new (?:Map|Set|WeakMap|WeakSet)\((?!\[)/],
  ['non-literal import()', /\bimport\(\s*[^'"`\s)]/],
];

const GREP_ALLOWED: Readonly<Record<string, readonly string[]>> = {
  'client/apiClient.ts': ['globalThis.fetch'],
};

function isScanned(path: string): boolean {
  return /\.ts$/.test(path) && !/\.test(?:-d)?\.ts$/.test(path) && !path.includes('__fixtures__/') && !path.startsWith('gates/');
}

function grepFindings(path: string, text: string): string[] {
  const allowed = new Set(GREP_ALLOWED[path] ?? []);
  const exempt = path in R17_ALLOWED;
  return text.split('\n').flatMap((line, index) =>
    GREP_LIST.filter(([name, pattern]) => pattern.test(line) && !allowed.has(name) && !(exempt && name === 'fs or path import')).map(([name]) => `${path}:${index + 1} ${name}: ${line.trim()}`)
  );
}

describe('G9 static checks', () => {
  it('nothing under apps/agent-forge is imported (module graph)', () => {
    const graph = moduleGraph([fileURLToPath(import.meta.url), join(REPO, 'src/workspaces/index.ts')]);
    expect(graph.files.size).toBeGreaterThan(100);
    expect([...graph.files].map((file) => relative(REPO, file)).filter((file) => file.startsWith('apps/'))).toEqual([]);
    expect([...graph.bare].filter((spec) => /agent-forge|forge/i.test(spec))).toEqual([]);
  });

  it('the P1.20 grep list finds no fs call or module-level mutable state under src/workspaces/ (R17)', () => {
    const root = join(REPO, 'src/workspaces');
    const findings = walk(root)
      .filter(isScanned)
      .flatMap((path) => grepFindings(path, realFs.readFileSync(join(root, path), 'utf8')));
    expect(findings).toEqual([]);
  });

  it('lousho/workspaces/client pulls in no crypto and no quickjs', () => {
    const graph = moduleGraph([join(REPO, 'src/workspaces/client/index.ts')]);
    expect([...graph.bare].filter((spec) => /^(?:node:)?crypto$|quickjs/.test(spec))).toEqual([]);
    expect([...graph.files].map((file) => relative(REPO, file)).filter((file) => file.startsWith('apps/'))).toEqual([]);
  });
});
