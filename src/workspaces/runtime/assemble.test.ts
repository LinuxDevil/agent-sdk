import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { MainHarness } from '../contracts/mainHarness';
import { readFixtureTree } from '../__fixtures__/readTree';
import { folderSource } from '../source/folderSource';
import { memorySource } from '../source/memorySource';
import { agentRunOptions, assembleInstructions, assembleMainInstructions, type AssembleInstructionsInput, type MainPageInfo } from './assemble';
import { loadWorkspace, type LoadedWorkspace } from './loadWorkspace';
import { resolveAttachments, type ResolvedAttachment } from './resolveAgents';
import { profileStoreFor, resolvePageHarness } from './resolveHarness';
import { resolveSharedContext } from './sharedContext';

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function textFiles(tree: Readonly<Record<string, unknown>>): Record<string, string> {
  return Object.fromEntries(Object.entries(tree).map(([path, value]) => [path, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`]));
}

const marketing = (): Record<string, string> => textFiles(readFixtureTree('marketing'));

function pageName(workspace: LoadedWorkspace, id: string): string {
  return (JSON.parse(workspace.tree[`pages/${id}/page.json`] as string) as { name: string }).name;
}

async function inputFor(workspace: LoadedWorkspace, pageId: string, alias: string, engineFraming?: string): Promise<AssembleInstructionsInput> {
  const attachments = await resolveAttachments(workspace, pageId, { mode: 'default' });
  const attachment = attachments.find((item) => item.alias === alias) as ResolvedAttachment;
  return {
    agent: attachment.agentOwned,
    shared: resolveSharedContext(workspace, { audience: { page: pageId } }),
    harness: resolvePageHarness(workspace, pageId, profileStoreFor(workspace)),
    attachment: attachment.pageOwned,
    page: { id: pageId, name: pageName(workspace, pageId) },
    ...(engineFraming !== undefined && { engineFraming }),
  };
}

const load = (files: Record<string, string>): Promise<LoadedWorkspace> => loadWorkspace(memorySource(files), { mode: 'default' });

function section(result: { sections: { id: string; text: string }[] }, id: string): string {
  return result.sections.find((item) => item.id === id)?.text ?? '';
}

describe('assembleInstructions', () => {
  it('script-maker on instagram and on facebook share section 1 byte for byte and differ in section 3', async () => {
    const workspace = await load(marketing());
    const instagram = assembleInstructions(await inputFor(workspace, 'instagram-videos', 'script'));
    const facebook = assembleInstructions(await inputFor(workspace, 'facebook-videos', 'script'));
    expect(section(instagram, 'agent')).toBe('Write a script that fits the requested length.');
    expect(section(instagram, 'agent')).toBe(section(facebook, 'agent'));
    expect(section(instagram, 'harness')).not.toBe(section(facebook, 'harness'));
    expect(section(instagram, 'harness')).toContain('## Task environment: Instagram');
    expect(section(instagram, 'harness')).toContain('Keep captions under 2200 characters.');
    expect(section(facebook, 'harness')).toContain('## Task environment: Facebook');
    expect(instagram.harnessPartHash).not.toBe(facebook.harnessPartHash);
  });

  it('puts the five sections in the fixed order with the fixed headings', async () => {
    const workspace = await load(marketing());
    const result = assembleInstructions(await inputFor(workspace, 'instagram-videos', 'script', 'Work towards the goal.'));
    expect(result.sections.map((item) => item.id)).toEqual(['agent', 'shared', 'harness', 'role', 'engine']);
    expect(section(result, 'shared').startsWith('## Workspace rules\n')).toBe(true);
    expect(section(result, 'role')).toBe('## Your role on this page\n\nWrites the script.');
    expect(section(result, 'engine')).toBe('## How this page runs\n\nWork towards the goal.');
    const order = ['Write a script', '## Workspace rules', '## Task environment: Instagram', '## Your role on this page', '## How this page runs'].map((needle) => result.text.indexOf(needle));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every((index) => index >= 0)).toBe(true);
  });

  it('the same attachment under single and goal-oriented has the same harnessPartHash', async () => {
    const workspace = await load(marketing());
    const single = assembleInstructions(await inputFor(workspace, 'instagram-videos', 'script'));
    const goal = assembleInstructions(await inputFor(workspace, 'instagram-videos', 'script', 'Keep going until the goal checks pass.'));
    expect(goal.harnessPartHash).toBe(single.harnessPartHash);
    expect(goal.harnessPart).toBe(single.harnessPart);
    expect(goal.text).not.toBe(single.text);
  });

  it('engine framing never changes the harness hash', async () => {
    const workspace = await load(marketing());
    const base = await inputFor(workspace, 'instagram-videos', 'script');
    const hashes = ['', 'a', 'a much longer framing\n\nwith paragraphs'].map((framing) => assembleInstructions({ ...base, engineFraming: framing }));
    expect(new Set(hashes.map((item) => item.harnessPartHash)).size).toBe(1);
    expect(new Set(hashes.map((item) => item.hash)).size).toBe(3);
    expect(hashes[0]?.harnessPart.includes('How this page runs')).toBe(false);
  });

  it('hash changes when only the harness changes', async () => {
    const files = marketing();
    const before = assembleInstructions(await inputFor(await load(files), 'instagram-videos', 'script'));
    const edited = { ...files, 'harness/brand-voice.md': `${files['harness/brand-voice.md']}\nAlways add a sign-off.` };
    const after = assembleInstructions(await inputFor(await load(edited), 'instagram-videos', 'script'));
    expect(after.hash).not.toBe(before.hash);
    expect(after.harnessPartHash).not.toBe(before.harnessPartHash);
    expect(section(after, 'agent')).toBe(section(before, 'agent'));
    expect(section(after, 'shared')).toBe(section(before, 'shared'));
    expect(section(after, 'role')).toBe(section(before, 'role'));
  });

  it('the harness never appears in the agent dir after a run', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lousho-assemble-'));
    dirs.push(root);
    for (const [path, text] of Object.entries(marketing())) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    const snapshot = (): Record<string, string> => {
      const out: Record<string, string> = {};
      const walk = (rel: string): void => {
        for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
          const path = rel === '' ? entry.name : `${rel}/${entry.name}`;
          if (entry.isDirectory()) walk(path);
          else out[path] = readFileSync(join(root, path), 'utf8');
        }
      };
      walk('');
      return out;
    };
    const before = snapshot();
    const workspace = await loadWorkspace(folderSource(root), { mode: 'default' });
    const result = assembleInstructions(await inputFor(workspace, 'instagram-videos', 'script'));
    expect(result.text).toContain('Keep captions under 2200 characters.');
    const after = snapshot();
    expect(after).toEqual(before);
    expect(Object.values(after).some((text) => text.includes('## Task environment'))).toBe(false);
    expect(workspace.tree['agents/script-maker/instructions.md']).toBe(before['agents/script-maker/instructions.md']);
  });

  it('lists a resource over the cap instead of inlining it', async () => {
    const files = { ...marketing(), 'shared/knowledge/big.md': 'x'.repeat(2000), 'shared/knowledge/small.md': 'tiny note' };
    const workspace = await load(files);
    const input = await inputFor(workspace, 'instagram-videos', 'script');
    const result = assembleInstructions({ ...input, shared: resolveSharedContext(workspace, { audience: { page: 'instagram-videos' }, maxResourceBytes: 100 }) });
    const shared = section(result, 'shared');
    expect(shared).toContain('tiny note');
    expect(shared).toContain('shared:knowledge/big.md');
    expect(shared).not.toContain('x'.repeat(100));
  });

  it('explains each section with where it came from', async () => {
    const workspace = await load(marketing());
    const result = assembleInstructions(await inputFor(workspace, 'instagram-videos', 'script'));
    const explained = result.explain();
    expect(explained.map((item) => item.id)).toEqual(['agent', 'shared', 'harness', 'role', 'engine']);
    expect(explained.find((item) => item.id === 'agent')?.provenance).toEqual(['agents/script-maker/instructions.md']);
    expect(explained.find((item) => item.id === 'shared')?.provenance).toContain('shared/instructions/00-brand-voice.md');
    expect(explained.find((item) => item.id === 'harness')?.provenance).toEqual(expect.arrayContaining(['harness/harness.json', 'workspace:platforms/instagram', 'pages/instagram-videos/harness/harness.json']));
    expect(explained.find((item) => item.id === 'role')?.provenance).toEqual(['pages/instagram-videos/agents.json#script.role']);
  });
});

describe('agentRunOptions', () => {
  it('maps model hints and takes the smallest limit of agent, attachment and harness', async () => {
    const workspace = await load(marketing());
    const [attachment] = await resolveAttachments(workspace, 'instagram-videos', { mode: 'default' });
    const harness = { ...resolvePageHarness(workspace, 'instagram-videos', profileStoreFor(workspace)), runtime: { limits: { maxTurns: 8, maxCostUsd: 2 }, modelHints: { temperature: 0.3, reasoning: 'low' as const } } };
    const resolved = {
      ...attachment,
      agentOwned: { ...attachment.agentOwned, limits: { maxSteps: 12, maxCostUsd: 1, maxDurationMs: 60_000 } },
      pageOwned: { ...attachment.pageOwned, limits: { maxTurns: 5, maxDurationMs: 90_000 } },
    };
    expect(agentRunOptions(resolved, harness)).toEqual({
      model: 'mock/mock-model',
      reasoning: 'low',
      modelSettings: { temperature: 0.3 },
      limits: { maxSteps: 5, maxCostUsd: 1, maxDurationMs: 60_000 },
    });
  });

  it('omits what no layer sets', async () => {
    const workspace = await load(marketing());
    const [attachment] = await resolveAttachments(workspace, 'instagram-videos', { mode: 'default' });
    const bare = { ...resolvePageHarness(workspace, 'instagram-videos', profileStoreFor(workspace)), runtime: undefined };
    const options = agentRunOptions({ ...attachment, model: { model: undefined, source: 'none' } }, bare);
    expect(options).toEqual({ limits: {} });
  });
});

describe('assembleMainInstructions', () => {
  const pages: MainPageInfo[] = [
    { id: 'instagram-videos', name: 'Instagram', description: 'Makes an Instagram video from a topic.' },
    { id: 'facebook-videos', name: 'Facebook', description: 'Makes a Facebook video from a topic.' },
    { id: 'content-research', name: 'Research', description: 'Researches a topic.' },
  ];
  const mainAgent = { instructions: 'Route each request to the page that fits it.' };

  it('with no main harness the main prompt lists every page description', async () => {
    const workspace = await load(marketing());
    const result = assembleMainInstructions({ mainAgent, shared: resolveSharedContext(workspace, { audience: 'main-agent' }), pages });
    for (const page of pages) expect(result.text).toContain(`${page.id}: ${page.description}`);
    expect(result.text.startsWith('Route each request')).toBe(true);
    expect(result.text).toContain('## Workspace rules');
  });

  it('shared context is left out when the main agent does not inherit it', async () => {
    const files = marketing();
    const workspace = await load({ ...files, 'workspace.json': files['workspace.json'].replace('"inheritsShared": true', '"inheritsShared": false') });
    const result = assembleMainInstructions({ mainAgent, shared: resolveSharedContext(workspace, { audience: 'main-agent' }), pages });
    expect(result.text).not.toContain('## Workspace rules');
  });

  it('a main harness drives routes, clarifying, presentation and failure handling', async () => {
    const harness = JSON.parse(marketing()['main-agent/harness/main-harness.json']) as MainHarness;
    const routing = 'Pick one page, then run it.';
    const result = assembleMainInstructions({ mainAgent, shared: undefined, mainHarness: { harness, texts: { 'main-agent/harness/routing.md': routing } }, pages });
    expect(result.text).toContain(routing);
    expect(result.text).toContain('instagram-videos: The user wants an Instagram video.');
    expect(result.text).toContain('The channel is not named.');
    expect(result.text).toContain('Short and friendly.');
    expect(result.text).toContain('ask');
    expect(result.text).not.toContain('Makes an Instagram video from a topic.');
    expect(result.explain().find((item) => item.id === 'routing')?.provenance).toContain('main-agent/harness/routing.md');
  });

  it('a listed prose file with no text is an error, and a bare name is accepted as the key', () => {
    const harness: MainHarness = { schema: 'lousho.main-harness/1', instructions: ['routing.md'] };
    expect(() => assembleMainInstructions({ mainAgent, shared: undefined, mainHarness: { harness, texts: {} }, pages })).toThrow(expect.objectContaining({ code: 'LOUSHO_WORKSPACE_MAIN_HARNESS_TEXT_MISSING', message: expect.stringContaining('routing.md') }));
    const result = assembleMainInstructions({ mainAgent, shared: undefined, mainHarness: { harness, texts: { 'routing.md': 'Bare key.' } }, pages });
    expect(result.text).toContain('Bare key.');
  });

  it('provenance names files, including the config field when the text came from there', async () => {
    const workspace = await load(marketing());
    const input = await inputFor(workspace, 'instagram-videos', 'script');
    expect(assembleInstructions({ ...input, instructionsSource: 'agent.yaml' }).explain()[0]?.provenance).toEqual(['agents/script-maker/agent.yaml#instructions']);
    expect(assembleMainInstructions({ mainAgent, shared: undefined, pages }).explain()[0]?.provenance).toEqual(['main-agent/instructions.md']);
    expect(assembleMainInstructions({ mainAgent: { ...mainAgent, instructionsSource: 'agent.json' }, shared: undefined, pages }).explain()[0]?.provenance).toEqual(['main-agent/agent.json#instructions']);
  });

  it('with no pages and no main harness the empty Pages block is left out', () => {
    expect(assembleMainInstructions({ mainAgent, shared: undefined, pages: [] }).text).not.toContain('### Pages');
  });

  it('empty routes and an empty clarify leave their headings out', () => {
    const harness: MainHarness = { schema: 'lousho.main-harness/1', routes: [], clarify: { askWhen: [], runImmediatelyWhen: [] } };
    const text = assembleMainInstructions({ mainAgent, shared: undefined, mainHarness: { harness, texts: {} }, pages }).text;
    expect(text).not.toContain('### Routes');
    expect(text).not.toContain('### Clarifying');
  });

  it('a main harness without routes still lists every page', () => {
    const harness: MainHarness = { schema: 'lousho.main-harness/1', presentation: { style: 'Brief.', followUps: 'None.', revisions: 'Ask.' } };
    const result = assembleMainInstructions({ mainAgent, shared: undefined, mainHarness: { harness, texts: {} }, pages });
    for (const page of pages) expect(result.text).toContain(`${page.id}: ${page.description}`);
    expect(result.text).toContain('Brief.');
  });

  it('hash changes when only the main harness changes', () => {
    const harness: MainHarness = { schema: 'lousho.main-harness/1', onPageFailure: 'report' };
    const a = assembleMainInstructions({ mainAgent, shared: undefined, mainHarness: { harness, texts: {} }, pages });
    const b = assembleMainInstructions({ mainAgent, shared: undefined, mainHarness: { harness: { ...harness, onPageFailure: 'retry-once' }, texts: {} }, pages });
    expect(a.hash).not.toBe(b.hash);
    expect(a.sections[0]).toEqual(b.sections[0]);
  });
});
