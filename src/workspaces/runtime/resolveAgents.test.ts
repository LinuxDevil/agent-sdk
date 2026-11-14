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
import { readAgentOwned } from './agentDirView';
import { resolveAgentDir } from '../../agentDir/loadAgentDir';
import { fileURLToPath } from 'node:url';

const dirs: string[] = [];

const fixtureDir = (name: string): string => fileURLToPath(new URL(`../__fixtures__/${name}`, import.meta.url));

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
    expect(a?.agentOwned).toMatchObject({ name: 'script-maker', version: '1.0.0', tools: ['search_facts'], toolFiles: ['tools/search_facts.ts'] });
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

  it('refuses code files and keys that need code or disk, which a workspace source cannot give', async () => {
    const files = marketing();
    const agent = JSON.parse(files['agents/script-maker/agent.json']) as Record<string, unknown>;
    const changes: Record<string, string>[] = [
      { 'agents/script-maker/agent.ts': 'export default {};' },
      { 'agents/script-maker/auth.ts': 'export default () => true;' },
      { 'agents/script-maker/hooks.ts': 'export default [];' },
      { 'agents/script-maker/agent.json': JSON.stringify({ ...agent, hooks: './hooks.ts' }) },
      { 'agents/script-maker/agent.json': JSON.stringify({ ...agent, approve: './approve.ts' }) },
      { 'agents/script-maker/agent.json': JSON.stringify({ ...agent, store: { dir: './.lousho' } }) },
    ];
    for (const change of changes) {
      const workspace = await load({ ...files, ...change });
      await expect(resolveAttachments(workspace, 'instagram-videos', { mode: 'default' })).rejects.toThrow(/agent\.json|agent\.ts|auth\.ts|hooks\.ts/);
      await expect(resolveAttachments(workspace, 'instagram-videos', { mode: 'default' })).rejects.toMatchObject({ code: 'LOUSHO_AGENT_DIR_INVALID' });
    }
  });

  it('names the config file an error is in', () => {
    const files = { 'agent.yaml': 'name: script-maker\nversion: 1.0.0\nmodel: gpt-4o\n', 'instructions.md': 'Write.' };
    expect(() => readAgentOwned({ format: 'dir', dir: 'agents/script-maker', files })).toThrow('agents/script-maker/agent.yaml');
  });

  it('carries permissions, limits, skill names and memory names', async () => {
    const files = marketing();
    const agent = JSON.parse(files['agents/script-maker/agent.json']) as Record<string, unknown>;
    const permissions = [{ tool: 'shell', action: 'deny', reason: 'No shell' }];
    const workspace = await load({
      ...files,
      'agents/script-maker/agent.json': JSON.stringify({ ...agent, permissions, limits: { maxSteps: 4 } }),
      'agents/script-maker/skills/outline/SKILL.md': '---\nname: outline-script\ndescription: Outline first\n---\nBody',
      'agents/script-maker/skills/hooks.md': '---\ndescription: Hook ideas\n---\nBody',
      'agents/script-maker/skills/notes.md': 'No frontmatter, not a skill.',
      'agents/script-maker/skills/loose/README.md': 'Not a skill folder.',
      'agents/script-maker/memory/facts.ts': 'export default {};',
    });
    const [script] = await resolveAttachments(workspace, 'instagram-videos', { mode: 'default' });
    expect(script.agentOwned).toMatchObject({ permissions, limits: { maxSteps: 4 }, skills: ['hooks', 'outline-script'], memory: ['facts'] });
  });

  it('matches resolveAgentDir on the fixture agent folders', async () => {
    const workspace = await load(marketing());
    const root = fixtureDir('marketing');
    for (const dir of ['agents/script-maker', 'agents/video-maker', 'agents/voice-maker', 'pages/content-research/agents/research-lead']) {
      const fromDisk = await resolveAgentDir(join(root, dir));
      const files = Object.fromEntries(Object.entries(workspace.tree).filter(([path]) => path.startsWith(`${dir}/`)).map(([path, text]) => [path.slice(dir.length + 1), String(text)]));
      const owned = readAgentOwned({ format: 'dir', dir, files });
      expect({ name: owned.name, description: owned.description, tools: owned.tools, skills: owned.skills, memory: owned.memory, instructions: owned.instructions }).toEqual({
        name: fromDisk.manifest.name,
        description: fromDisk.manifest.description,
        tools: fromDisk.manifest.tools,
        skills: fromDisk.manifest.skills,
        memory: fromDisk.manifest.memory,
        instructions: fromDisk.config.instructions,
      });
    }
  });

  it('matches resolveAgentDir on a fixture agent with skills and memory', async () => {
    const tree = textFiles(readFixtureTree('parity-agents'));
    const dir = 'note-keeper';
    const fromDisk = await resolveAgentDir(join(fixtureDir('parity-agents'), dir));
    const files = Object.fromEntries(Object.entries(tree).filter(([path]) => path.startsWith(`${dir}/`)).map(([path, text]) => [path.slice(dir.length + 1), text]));
    const owned = readAgentOwned({ format: 'dir', dir, files });
    expect(owned.skills).toEqual(['hooks', 'outline-notes']);
    expect(owned.memory).toEqual(['notes']);
    expect({ tools: owned.tools, skills: owned.skills, memory: owned.memory, instructions: owned.instructions }).toEqual({
      tools: fromDisk.manifest.tools,
      skills: fromDisk.manifest.skills,
      memory: fromDisk.manifest.memory,
      instructions: fromDisk.config.instructions,
    });
  });

  it('refuses Studio keys and agent folders a workspace agent would silently ignore', () => {
    const studio = { version: 2, name: 'helper', model: 'openai/gpt-4o', instructions: 'Help.' };
    const extras: Record<string, unknown>[] = [
      { mcpServers: { docs: { url: 'https://x.test/mcp' } } },
      { guardrails: [{ id: 'g1', name: 'pii' }] },
      { subagents: { billing: { ref: 'agents/billing.yaml' } } },
      { handoffs: [{ agent: 'billing' }] },
      { triggers: [{ id: 'chat', type: 'chat' }] },
      { flow: { code: 'f', name: 'F', flow: { type: 'end', id: 'x' } } },
    ];
    for (const extra of extras) {
      const key = Object.keys(extra)[0];
      expect(() => readAgentOwned({ format: 'studio', dir: 'agents/helper', files: { 'spec.json': JSON.stringify({ ...studio, ...extra }) } })).toThrow(`'${key}' is not run for a workspace agent`);
    }
    for (const folder of ['subagents/helper/agent.json', 'schedules/daily.json', 'channels/slack.json']) {
      const files = { 'instructions.md': 'Write.', [folder]: '{}' };
      expect(() => readAgentOwned({ format: 'dir', dir: 'agents/writer', files })).toThrow(`agents/writer/${folder.split('/')[0]}/`);
    }
  });

  it('names a Studio file tool by its file stem, as a folder agent does', () => {
    const spec = { version: 2, name: 'helper', model: 'openai/gpt-4o', instructions: 'Help.', tools: [{ file: 'tools/web.ts' }, { builtin: 'web_fetch' }] };
    const owned = readAgentOwned({ format: 'studio', dir: 'agents/helper', files: { 'spec.json': JSON.stringify(spec) } });
    expect(owned.tools).toEqual(['web', 'web_fetch']);
    expect(owned.toolFiles).toEqual(['tools/web.ts']);
  });

  it('names a Studio tool by what the model sees, not its canvas id, and keeps approval always', () => {
    const spec = { version: 2, name: 'helper', model: 'openai/gpt-4o', instructions: 'Help.', tools: [{ builtin: 'web_fetch', id: 'fetch', approval: 'always' }, { file: 'tools/post.ts', id: 'poster' }] };
    const owned = readAgentOwned({ format: 'studio', dir: 'agents/helper', files: { 'spec.json': JSON.stringify(spec) } });
    expect(owned.tools).toEqual(['web_fetch', 'post']);
    expect(owned.approvals).toEqual(['web_fetch']);
  });

  it('refuses agent settings a workspace agent would silently drop', () => {
    const studio = { version: 2, name: 'helper', model: 'openai/gpt-4o', instructions: 'Help.' };
    const extras: Record<string, unknown>[] = [
      { permissionMode: 'acceptEdits' },
      { approvalTtlMs: 60_000 },
      { codeMode: true },
      { toolSearch: false },
      { output: { jsonSchema: { type: 'object', properties: {} } } },
      { promptRef: 'helper@prod' },
    ];
    for (const extra of extras) {
      const key = Object.keys(extra)[0];
      expect(() => readAgentOwned({ format: 'studio', dir: 'agents/helper', files: { 'spec.json': JSON.stringify({ ...studio, ...extra }) } })).toThrow(`'${key}' is not applied to a workspace agent`);
    }
    for (const extra of [{ permissionMode: 'acceptEdits' }, { projectInstructions: true }, { approvalTtlMs: 60_000 }, { output: { type: 'object', properties: {} } }]) {
      const key = Object.keys(extra)[0];
      const files = { 'instructions.md': 'Write.', 'agent.json': JSON.stringify(extra) };
      expect(() => readAgentOwned({ format: 'dir', dir: 'agents/writer', files })).toThrow(`'${key}' is not applied to a workspace agent`);
    }
  });

  it('does not cache a failed global lookup, and refuses a cache it did not make', async () => {
    const workspace = await load(withGlobal(marketing()));
    let fail = true;
    const registry = sourceAgentRegistry(memorySource(globalAgents()));
    const globalRegistry: GlobalAgentRegistry = {
      resolve: async (name, range) => {
        if (fail) throw new Error('registry down');
        return registry.resolve(name, range);
      },
    };
    const cache = createAgentCache();
    await expect(resolveAttachments(workspace, 'content-research', { mode: 'default', globalRegistry, cache })).rejects.toThrow('registry down');
    fail = false;
    const resolved = await resolveAttachments(workspace, 'content-research', { mode: 'default', globalRegistry, cache });
    expect(resolved.find((item) => item.alias === 'checker')?.version).toBe('1.0.0');
    await expect(resolveAttachments(workspace, 'content-research', { mode: 'default', cache: { kind: 'agent-cache' } })).rejects.toMatchObject({ code: 'LOUSHO_VALIDATION_FAILED' });
  });
});

describe('global agent registries', () => {
  it('refuse a name or range outside the ref grammar before reading', async () => {
    let reads = 0;
    const source = memorySource(globalAgents());
    const counted = { ...source, list: async (prefix: string) => (reads++, source.list(prefix)) };
    for (const registry of [sourceAgentRegistry(counted), projectAgentRegistry('/nonexistent-lousho-root')]) {
      for (const [name, range] of [['../etc', '^1'], ['Fact', '^1'], ['fact-checker', '>=1.0.0'], ['fact-checker', '*']]) {
        await expect(registry.resolve(name, range)).rejects.toMatchObject({ code: 'LOUSHO_WORKSPACE_AGENT_UNRESOLVED' });
      }
    }
    expect(reads).toBe(0);
  });

  it('projectAgentRegistry serves the highest Studio version in range from its snapshot, and writes nothing', async () => {
    const spec = (instructions: string) => ({ version: 2, name: 'fact-checker', model: 'anthropic/claude-y', instructions, tools: [{ builtin: 'web_fetch' }], permissions: [{ id: 'no-shell', tool: 'shell', action: 'deny' }] });
    const record = (version: number, instructions: string) => JSON.stringify({ version, snapshot: { spec: spec(instructions), labels: [] } });
    const root = folderOf({
      ...globalAgents(),
      'agents/old-checker/agent.json': JSON.stringify({ name: 'old-checker', version: '0.9.0' }),
      'agents/old-checker/instructions.md': 'Old.',
      '.lousho/agents/fact-checker.yaml': 'version: 2\nname: fact-checker\nmodel: anthropic/claude-y\ninstructions: Unsaved working copy.\n',
      '.lousho/agents/fact-checker/versions/index.jsonl': '{"version":2}\n{"version":3}\nnot json\n',
      '.lousho/agents/fact-checker/versions/000002.json': record(2, 'Version two.'),
      '.lousho/agents/fact-checker/versions/000003.json': record(3, 'Version three.'),
    });
    const before = snapshot(root);
    const registry = projectAgentRegistry(root);
    expect(await registry.resolve('fact-checker', '^2')).toMatchObject({ version: '2.0.0', dir: '.lousho/agents/fact-checker/versions/000002.json', format: 'studio' });
    expect(await registry.resolve('fact-checker', '^1')).toMatchObject({ version: '1.0.0', dir: 'agents/fact-checker', format: 'dir' });
    expect(await registry.resolve('old-checker', '^1')).toBeUndefined();
    expect(await registry.resolve('nobody', '^1')).toBeUndefined();

    const files = withGlobal(marketing());
    const doc = JSON.parse(files['pages/content-research/agents.json']) as { agents: { as: string; ref: string }[] };
    doc.agents[2].ref = 'global:fact-checker@^3';
    const workspace = await load({ ...files, 'pages/content-research/agents.json': JSON.stringify(doc) });
    const checker = (await resolveAttachments(workspace, 'content-research', { mode: 'default', globalRegistry: registry })).find((item) => item.alias === 'checker');
    expect(checker?.version).toBe('3.0.0');
    expect(checker?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(checker?.agentOwned).toMatchObject({ name: 'fact-checker', defaultModel: 'anthropic/claude-y', instructions: 'Version three.', tools: ['web_fetch'], permissions: [{ tool: 'shell', action: 'deny' }] });
    expect(snapshot(root)).toEqual(before);
  });
});
