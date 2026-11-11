import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readFixtureTree } from '../__fixtures__/readTree';
import { memorySource } from '../source/memorySource';
import { projectAgentRegistry } from '../source/projectAgentRegistry';
import { sourceAgentRegistry, type GlobalAgentRegistry } from './agentRegistry';
import { loadWorkspace, type LoadedWorkspace } from './loadWorkspace';
import { createAgentCache, resolveAttachments } from './resolveAgents';

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function textFiles(tree: Readonly<Record<string, unknown>>, prefix = ''): Record<string, string> {
  return Object.fromEntries(Object.entries(tree).map(([path, value]) => [`${prefix}${path}`, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`]));
}

function folderOf(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'lousho-agents-'));
  dirs.push(dir);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

function snapshot(dir: string): Record<string, number> {
  const out: Record<string, number> = {};
  const walk = (rel: string): void => {
    for (const name of readdirSync(join(dir, rel))) {
      const path = rel === '' ? name : `${rel}/${name}`;
      const info = statSync(join(dir, path));
      if (info.isDirectory()) walk(path);
      else out[path] = info.mtimeMs;
    }
  };
  walk('');
  return out;
}

const marketing = (): Record<string, string> => textFiles(readFixtureTree('marketing'));

const globalAgents = (): Record<string, string> => textFiles(readFixtureTree('global-agents'), 'agents/');

function withGlobal(files: Record<string, string>): Record<string, string> {
  const path = 'pages/content-research/agents.json';
  const doc = JSON.parse(files[path]) as { agents: unknown[] };
  doc.agents.push({ as: 'checker', ref: 'global:fact-checker@^1', model: 'anthropic/claude-x' });
  return { ...files, [path]: JSON.stringify(doc) };
}

async function load(files: Record<string, string>): Promise<LoadedWorkspace> {
  return loadWorkspace(memorySource(files), { mode: 'default' });
}

function countingTree(workspace: LoadedWorkspace, counts: Map<string, number>): LoadedWorkspace {
  const tree = new Proxy(workspace.tree, {
    get(target, key, receiver) {
      if (typeof key === 'string' && key in target) counts.set(key, (counts.get(key) ?? 0) + 1);
      return Reflect.get(target, key, receiver) as unknown;
    },
  });
  return { ...workspace, tree };
}

describe('resolveAttachments', () => {
  it('instagram and facebook resolve workspace:script-maker to the same dir and hash', async () => {
    const workspace = await load(marketing());
    const cache = createAgentCache();
    const instagram = await resolveAttachments(workspace, 'instagram-videos', { mode: 'default', cache });
    const facebook = await resolveAttachments(workspace, 'facebook-videos', { mode: 'default', cache });
    const a = instagram.find((item) => item.alias === 'script');
    const b = facebook.find((item) => item.alias === 'script');
    expect(a?.dir).toBe('agents/script-maker');
    expect(a?.dir).toBe(b?.dir);
    expect(a?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(a?.sha256).toBe(b?.sha256);
    expect(a?.agentOwned).toMatchObject({ name: 'script-maker', version: '1.0.0', tools: ['tools/search_facts.ts'] });
    expect(a?.agentOwned.instructions).toBeTruthy();
    expect(a?.pageOwned).toEqual({ as: 'script', ref: 'workspace:script-maker', role: 'Writes the script.' });
    expect(a?.model).toEqual({ model: 'mock/mock-model', source: 'workspace' });
    expect(instagram.map((item) => item.alias)).toEqual(['script', 'video', 'voice']);
  });

  it('local:researcher resolves under the page', async () => {
    const files = marketing();
    const path = 'pages/content-research/agents.json';
    const doc = JSON.parse(files[path]) as { agents: { as: string; ref: string }[] };
    doc.agents[0] = { as: 'lead', ref: 'local:researcher' };
    const renamed = Object.fromEntries(
      Object.entries({ ...files, [path]: JSON.stringify(doc) }).map(([file, text]) => [file.replace('pages/content-research/agents/research-lead/', 'pages/content-research/agents/researcher/'), text])
    );
    const workspace = await load(renamed);
    const [lead] = await resolveAttachments(workspace, 'content-research', { mode: 'default' });
    expect(lead).toMatchObject({ alias: 'lead', ref: 'local:researcher', dir: 'pages/content-research/agents/researcher' });
    expect(lead.agentOwned.version).toBe('1.0.0');
    expect(lead.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('global:fact-checker@^1 resolves via the injected registry and records its version and hash', async () => {
    const workspace = await load(withGlobal(marketing()));
    const registry = sourceAgentRegistry(memorySource(globalAgents()));
    const calls: string[] = [];
    const globalRegistry: GlobalAgentRegistry = {
      resolve: (name, range) => {
        calls.push(`${name}@${range}`);
        return registry.resolve(name, range);
      },
    };
    const cache = createAgentCache();
    const resolved = await resolveAttachments(workspace, 'content-research', { mode: 'default', globalRegistry, cache });
    await resolveAttachments(workspace, 'content-research', { mode: 'default', globalRegistry, cache });
    const checker = resolved.find((item) => item.alias === 'checker');
    expect(checker).toMatchObject({ ref: 'global:fact-checker@^1', dir: 'agents/fact-checker', version: '1.0.0' });
    expect(checker?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(checker?.agentOwned.description).toBe('Checks the claims in a draft against sources.');
    expect(checker?.model).toEqual({ model: 'anthropic/claude-x', source: 'attachment' });
    expect(calls).toEqual(['fact-checker@^1']);
  });

  it('the agent dir is read once for three pages', async () => {
    const counts = new Map<string, number>();
    const workspace = countingTree(await load(marketing()), counts);
    const cache = createAgentCache();
    for (const page of ['instagram-videos', 'facebook-videos', 'content-research']) await resolveAttachments(workspace, page, { mode: 'default', cache });
    const reads = [...counts].filter(([path]) => path.startsWith('agents/script-maker/'));
    expect(reads.map(([path]) => path).sort()).toEqual(['agents/script-maker/agent.json', 'agents/script-maker/instructions.md', 'agents/script-maker/tools/search_facts.ts']);
    expect(reads.every(([, count]) => count === 1)).toBe(true);
  });

  it('a global ref with no registry, or no matching version, throws LOUSHO_WORKSPACE_AGENT_UNRESOLVED', async () => {
    const workspace = await load(withGlobal(marketing()));
    await expect(resolveAttachments(workspace, 'content-research', { mode: 'default' })).rejects.toMatchObject({ code: 'LOUSHO_WORKSPACE_AGENT_UNRESOLVED' });
    const globalRegistry = sourceAgentRegistry(memorySource({}));
    await expect(resolveAttachments(workspace, 'content-research', { mode: 'default', globalRegistry })).rejects.toMatchObject({ code: 'LOUSHO_WORKSPACE_AGENT_UNRESOLVED' });
    await expect(resolveAttachments(workspace, 'missing', { mode: 'default' })).rejects.toMatchObject({ code: 'LOUSHO_WORKSPACE_AGENT_UNRESOLVED' });
  });

  it('page and workspace models.provider wrap the agent default through resolvePageModel', async () => {
    const files = marketing();
    const agent = JSON.parse(files['agents/script-maker/agent.json']) as Record<string, unknown>;
    const page = JSON.parse(files['pages/instagram-videos/page.json']) as Record<string, unknown>;
    const manifest = JSON.parse(files['workspace.json']) as Record<string, unknown>;
    const workspace = await load({
      ...files,
      'agents/script-maker/agent.json': JSON.stringify({ ...agent, model: 'openrouter/x' }),
      'workspace.json': JSON.stringify({ ...manifest, models: { provider: 'pi' } }),
      'pages/facebook-videos/page.json': JSON.stringify({ ...JSON.parse(files['pages/facebook-videos/page.json']), models: { provider: null } }),
      'pages/instagram-videos/page.json': JSON.stringify(page),
    });
    const [instagram] = await resolveAttachments(workspace, 'instagram-videos', { mode: 'default' });
    const [facebook] = await resolveAttachments(workspace, 'facebook-videos', { mode: 'default' });
    expect(instagram.model).toEqual({ model: 'pi/openrouter/x', source: 'agent' });
    expect(facebook.model).toEqual({ model: 'openrouter/x', source: 'agent' });
  });

  it('refuses an agent default model that is not provider/model', async () => {
    const files = marketing();
    for (const model of [' openrouter/x', 'gpt-4o']) {
      const workspace = await load({ ...files, 'agents/script-maker/agent.json': JSON.stringify({ name: 'script-maker', version: '1.0.0', model }) });
      await expect(resolveAttachments(workspace, 'instagram-videos', { mode: 'default' })).rejects.toMatchObject({ code: 'LOUSHO_AGENT_DIR_INVALID' });
    }
  });

  it('refuses broken agent configs and instructions with LOUSHO_AGENT_DIR_INVALID', async () => {
    const files = marketing();
    const broken: Record<string, string>[] = [
      { 'agents/script-maker/agent.yaml': 'name: script-maker\n' },
      { 'agents/script-maker/instructions.md': '   ' },
      { 'agents/script-maker/agent.json': JSON.stringify({ name: 'script-maker', version: 1 }) },
      { 'agents/script-maker/agent.json': JSON.stringify({ name: 'script-maker', instructions: 'twice' }) },
    ];
    for (const change of broken) {
      const workspace = await load({ ...files, ...change });
      await expect(resolveAttachments(workspace, 'instagram-videos', { mode: 'default' })).rejects.toMatchObject({ code: 'LOUSHO_AGENT_DIR_INVALID' });
    }
  });

  it('refuses a code config, which a workspace source cannot run', async () => {
    const files = marketing();
    const workspace = await load({ ...files, 'agents/script-maker/agent.ts': 'export default {};' });
    await expect(resolveAttachments(workspace, 'instagram-videos', { mode: 'default' })).rejects.toMatchObject({ code: 'LOUSHO_AGENT_DIR_INVALID' });
  });
});

describe('projectAgentRegistry', () => {
  it('picks the highest version in range from agent folders and Studio YAML, and writes nothing', async () => {
    const root = folderOf({
      ...globalAgents(),
      'agents/old-checker/agent.json': JSON.stringify({ name: 'old-checker', version: '0.9.0' }),
      'agents/old-checker/instructions.md': 'Old.',
      '.lousho/agents/fact-checker.yaml': 'version: 2\nname: fact-checker\nmodel: anthropic/claude-y\ninstructions: Checks newer claims.\ntools:\n  - builtin: web_fetch\n',
      '.lousho/agents/fact-checker/versions/index.jsonl': '{"version":1}\n{"version":2}\n',
    });
    const before = snapshot(root);
    const registry = projectAgentRegistry(root);
    const studio = await registry.resolve('fact-checker', '^2');
    expect(studio).toMatchObject({ name: 'fact-checker', version: '2.0.0', dir: '.lousho/agents/fact-checker.yaml', format: 'studio' });
    const folder = await registry.resolve('fact-checker', '^1');
    expect(folder).toMatchObject({ version: '1.0.0', dir: 'agents/fact-checker', format: 'dir' });
    expect(await registry.resolve('old-checker', '^1')).toBeUndefined();
    expect(await registry.resolve('nobody', '^1')).toBeUndefined();

    const files = withGlobal(marketing());
    const doc = JSON.parse(files['pages/content-research/agents.json']) as { agents: { as: string; ref: string }[] };
    doc.agents[2].ref = 'global:fact-checker@^2';
    const workspace = await load({ ...files, 'pages/content-research/agents.json': JSON.stringify(doc) });
    const checker = (await resolveAttachments(workspace, 'content-research', { mode: 'default', globalRegistry: registry })).find((item) => item.alias === 'checker');
    expect(checker?.version).toBe('2.0.0');
    expect(checker?.agentOwned).toMatchObject({ name: 'fact-checker', defaultModel: 'anthropic/claude-y', instructions: 'Checks newer claims.', tools: ['web_fetch'] });
    expect(snapshot(root)).toEqual(before);
  });
});
