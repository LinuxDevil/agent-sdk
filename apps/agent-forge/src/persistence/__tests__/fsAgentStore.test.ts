import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSpec, AgentSpecV2 } from '@lousho/build-ai-agent';
import { AgentRepo } from '../../../server/storage/agentRepo';
import { createFsAgentStore } from '../fsAgentStore';

const spec: AgentSpec = {
  name: 'ops-pipeline',
  prompt: 'Coordinate the ops pipeline.',
  provider: { type: 'mock', model: 'mock-1' },
};

describe('createFsAgentStore', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-forge-fsstore-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes a spec to .lousho/agents/<id>.yaml and reads it back through the v1 facade', async () => {
    const store = createFsAgentStore(tmpDir);
    await store.save('ops-pipeline', spec);

    const filePath = path.join(tmpDir, '.lousho', 'agents', 'ops-pipeline.yaml');
    expect(fs.existsSync(filePath)).toBe(true);

    const loaded = await store.load('ops-pipeline');
    expect(loaded).toEqual(spec);
  });

  it('stores the spec v2 working copy on disk', async () => {
    const store = createFsAgentStore(tmpDir);
    await store.save('ops-pipeline', spec);

    const filePath = path.join(tmpDir, '.lousho', 'agents', 'ops-pipeline.yaml');
    const onDisk = parseYaml(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    expect(onDisk.version).toBe(2);
    expect(onDisk.model).toBe('mock/mock-1');
    expect(onDisk.instructions).toBe('Coordinate the ops pipeline.');
    expect(onDisk).not.toHaveProperty('prompt');
    expect(onDisk).not.toHaveProperty('provider');
  });

  it('keeps v2-only keys (description, skills, guardrail ids) when a v1 save only changes the prompt', async () => {
    const repo = new AgentRepo(tmpDir);
    const store = createFsAgentStore(tmpDir, repo);
    const stored = {
      version: 2,
      name: 'ops-pipeline',
      model: 'mock/mock-1',
      instructions: 'old prompt',
      description: 'kept across saves',
      skills: [{ registry: 'summarizer' }],
      guardrails: [{ id: 'g9', name: 'pii' }],
    } as unknown as AgentSpecV2;
    await repo.writeSpec('ops-pipeline', stored);

    const legacy = (await store.load('ops-pipeline'))!;
    await store.save('ops-pipeline', { ...legacy, prompt: 'new prompt' });

    const after = (await repo.readSpec('ops-pipeline'))! as AgentSpecV2 & {
      description?: string;
      skills?: unknown[];
    };
    expect(after.instructions).toBe('new prompt');
    expect(after.description).toBe('kept across saves');
    expect(after.skills).toEqual([{ registry: 'summarizer' }]);
    expect(after.guardrails).toEqual([{ id: 'g9', name: 'pii' }]);
  });

  it('returns undefined for a missing id and empty list before any save', async () => {
    const store = createFsAgentStore(tmpDir);
    expect(await store.load('missing')).toBeUndefined();
    expect(await store.list()).toEqual([]);
  });

  it('lists saved entries', async () => {
    const store = createFsAgentStore(tmpDir);
    await store.save('ops-pipeline', spec);
    const entries = await store.list();
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe('ops-pipeline');
    expect(entries[0].spec).toEqual(spec);
  });

  it('removes a saved entry', async () => {
    const store = createFsAgentStore(tmpDir);
    await store.save('ops-pipeline', spec);
    await store.remove('ops-pipeline');
    expect(await store.load('ops-pipeline')).toBeUndefined();
  });

  it('baselines a hand-edited yaml before a save overwrites it (external_file_edit)', async () => {
    const repo = new AgentRepo(tmpDir);
    const store = createFsAgentStore(tmpDir, repo);
    await store.save('ops-pipeline', spec);

    // A hand edit outside Studio: same file, new instructions, no working.json update.
    const onDisk = parseYaml(fs.readFileSync(repo.specPath('ops-pipeline'), 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(repo.specPath('ops-pipeline'), stringifyYaml({ ...onDisk, instructions: 'hand edited prompt' }), 'utf8');

    await store.save('ops-pipeline', { ...spec, prompt: 'saved prompt' });

    const versionsDir = path.join(repo.sidecarDir('ops-pipeline'), 'versions');
    const lines = fs
      .readFileSync(path.join(versionsDir, 'index.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { kind: string; source: string });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ kind: 'baseline', source: 'external_file_edit' });
    const record = JSON.parse(fs.readFileSync(path.join(versionsDir, '000001.json'), 'utf8')) as {
      snapshot: { spec: { instructions: string } };
    };
    // The baseline holds the hand-edited content - the autosave that
    // triggered it wrote no version of its own.
    expect(record.snapshot.spec.instructions).toBe('hand edited prompt');
    expect((await repo.readSpec('ops-pipeline'))!.instructions).toBe('saved prompt');
  });

  it('two Studio saves in a row (autosave) never create a baseline', async () => {
    const store = createFsAgentStore(tmpDir);
    await store.save('ops-pipeline', spec);
    await store.save('ops-pipeline', { ...spec, prompt: 'tweaked prompt' });
    const indexPath = path.join(tmpDir, '.lousho', 'agents', 'ops-pipeline', 'versions', 'index.jsonl');
    expect(fs.existsSync(indexPath)).toBe(false);
  });

  it('skips an unreadable file or an invalid id instead of failing the whole list', async () => {
    const store = createFsAgentStore(tmpDir);
    await store.save('good', spec);
    const dir = path.join(tmpDir, '.lousho', 'agents');
    fs.writeFileSync(path.join(dir, 'broken.yaml'), 'name: [unclosed', 'utf8');
    fs.writeFileSync(path.join(dir, 'My Agent.yaml'), 'name: x\nprompt: y\nprovider: { type: mock, model: m }\n', 'utf8');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await store.list()).map((e) => e.id)).toEqual(['good']);
    warn.mockRestore();
  });
});
