import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { defineTool, type LLMProvider } from 'lousho';
import { mockModel, type MockModel, type MockRequest } from 'lousho/testing';
import {
  checkRegistry,
  createWorkspaceStores,
  ENGINES,
  fileArtifactStore,
  fileHostBackend,
  singleEngine,
  type ArtifactSink,
  type EngineRegistry,
  type PageEngineFactory,
  type WorkspaceHost,
  type WorkspaceCheckRegistry,
} from 'lousho/workspaces';

export const WORKSPACE_DIR = fileURLToPath(new URL('./workspace', import.meta.url));

export const WORKSPACE_ID = 'marketing';

export const PAGES = ['instagram-videos', 'facebook-videos'] as const;

export type PageId = (typeof PAGES)[number];

function walk(root: string, prefix: string): string[] {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap((entry) => {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    return entry.isDirectory() ? walk(root, path) : [path];
  });
}

export function readWorkspaceFiles(root: string = WORKSPACE_DIR): Record<string, string> {
  return Object.fromEntries(walk(root, '').sort().map((path) => [path, readFileSync(join(root, path), 'utf8')]));
}

const currentSink = new AsyncLocalStorage<ArtifactSink>();

function sinkOfRun(): ArtifactSink {
  const sink = currentSink.getStore();
  if (!sink) throw new Error('an artifact tool ran outside a page run');
  return sink;
}

function withRunSink(factory: PageEngineFactory): PageEngineFactory {
  return (setup) => {
    const engine = factory(setup);
    return { type: engine.type, run: (input, ctx) => currentSink.run(ctx.artifacts, () => engine.run(input, ctx)) };
  };
}

const renderVideo = defineTool({
  name: 'render_video',
  description: 'Mock renderer: stores a few placeholder bytes as the run\'s video artifact.',
  input: z.object({ script: z.string() }),
  execute: async ({ script }) => {
    const ref = await sinkOfRun().put('video', `placeholder video for: ${script}`, 'video/mp4');
    return { artifact: ref.name, bytes: ref.bytes };
  },
});

const synthesizeVoice = defineTool({
  name: 'synthesize_voice',
  description: 'Mock voice synthesis: stores a few placeholder bytes as the run\'s voice artifact.',
  input: z.object({ script: z.string() }),
  execute: async ({ script }) => {
    const ref = await sinkOfRun().put('voice', `placeholder audio for: ${script}`, 'audio/mpeg');
    return { artifact: ref.name, bytes: ref.bytes };
  },
});

const searchFacts = defineTool({
  name: 'search_facts',
  description: 'Mock fact search that returns a placeholder fact.',
  input: z.object({ query: z.string() }),
  execute: ({ query }) => ({ fact: `placeholder fact about ${query}` }),
});

const scriptPresent = {
  evaluate: (output: unknown) => {
    const value = typeof output === 'object' && output !== null ? (output as Record<string, unknown>).script : undefined;
    const passed = typeof value === 'string' && value.trim().length > 0;
    return { score: passed ? 1 : 0, passed, threshold: 1, ...(passed ? {} : { message: 'output.script is missing or empty' }) };
  },
};

export const marketingChecks: WorkspaceCheckRegistry = checkRegistry({
  'script-present': scriptPresent,
  'brand-voice-applied': {
    evaluate: (output: unknown) => {
      const passed = typeof output === 'object' && output !== null && Object.values(output).some((value) => typeof value === 'string' && value.trim().length > 0);
      return { score: passed ? 1 : 0, passed, threshold: 1 };
    },
  },
});

function lastUserText(request: MockRequest): string {
  const user = [...request.messages].reverse().find((message) => message.role === 'user');
  return typeof user?.content === 'string' ? user.content : '';
}

function topicOf(request: MockRequest): string {
  return /"topic":\s*"([^"]*)"/.exec(lastUserText(request))?.[1] ?? 'the topic';
}

export function scriptedMarketingModel(): MockModel {
  return mockModel(
    [
      (request) => {
        const script = `Three quick facts about ${topicOf(request)}.`;
        const toolsRun = request.messages.filter((message) => message.role === 'tool').length;
        if (toolsRun === 0) return { toolCalls: [{ name: 'render_video', args: { script } }] };
        if (toolsRun === 1) return { toolCalls: [{ name: 'synthesize_voice', args: { script } }] };
        return JSON.stringify({ script });
      },
    ],
    { onExhausted: 'repeat-last' }
  );
}

export interface MarketingHostOptions {
  storageDir: string;
  provider?: LLMProvider;
  providers?: (ref: string) => LLMProvider;
}

export function marketingHost(options: MarketingHostOptions): WorkspaceHost {
  mkdirSync(options.storageDir, { recursive: true });
  const fallback = options.provider ?? scriptedMarketingModel();
  const engines: EngineRegistry = { ...ENGINES, single: withRunSink(singleEngine) };
  return {
    tools: {
      render_video: { descriptor: renderVideo },
      synthesize_voice: { descriptor: synthesizeVoice },
      search_facts: { descriptor: searchFacts },
    },
    policyCeiling: { permissions: [], tools: { allow: ['*'] }, secrets: [] },
    providers: { resolve: (ref) => (options.providers ? options.providers(ref) : fallback) },
    secrets: { resolve: async () => undefined },
    stores: {
      ...createWorkspaceStores(fileHostBackend(join(options.storageDir, 'state')), { projectId: 'marketing-example', workspaceId: WORKSPACE_ID }),
      artifacts: fileArtifactStore(join(options.storageDir, 'artifacts')),
    },
    globals: {
      agents: { resolve: async () => undefined },
      profiles: {
        get: () => {
          throw new Error('this workspace uses no global profiles');
        },
      },
    },
    bindTool: (descriptor) => descriptor,
    checks: marketingChecks,
    engines,
  };
}
