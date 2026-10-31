import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentSpecV2 } from '@lousho/build-ai-agent';
import { AgentRepo, InvalidSpecError } from '../agentRepo';
import { specHash } from '../specHash';
import type { AgentMeta, CanvasLayout } from '../../../shared/wireTypes';

/** A v2 spec exercising landed sections (tools, guardrails) and a pending one (triggers). */
const SPEC = {
  version: 2,
  name: 'ops',
  model: 'mock/mock-1',
  instructions: 'Run the ops checks.',
  tools: [{ builtin: 'web_fetch' }],
  guardrails: [{ id: 'g1', name: 'pii', on: 'input' }],
  triggers: [{ id: 't1', type: 'cron', cron: '0 9 * * *', prompt: 'morning sweep' }],
} as unknown as AgentSpecV2;

describe('AgentRepo', () => {
  let baseDir: string;
  let repo: AgentRepo;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-d02-repo-'));
    repo = new AgentRepo(baseDir);
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it('writeSpec then readSpec round-trips a v2 spec with tools, guardrails and triggers verbatim', async () => {
    await repo.writeSpec('ops', SPEC);
    expect(fs.existsSync(repo.specPath('ops'))).toBe(true);
    expect(await repo.readSpec('ops')).toEqual(SPEC);
  });

  it('writeSpec rejects an invalid spec with InvalidSpecError (issues[0].path) and writes no file', async () => {
    const bad = { version: 2, name: '' } as unknown as AgentSpecV2;
    const error = await repo.writeSpec('bad', bad).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvalidSpecError);
    const invalid = error as InvalidSpecError;
    expect(invalid.code).toBe('LOUSHO_SPEC_INVALID');
    expect(invalid.issues[0].path).toBe('name');
    expect(invalid.message).toBe(`Invalid agent spec: name: ${invalid.issues[0].message}`);
    expect(fs.existsSync(repo.specPath('bad'))).toBe(false);
    expect(fs.existsSync(path.join(repo.sidecarDir('bad'), 'working.json'))).toBe(false);
  });

  it('writeSpec still rejects when pending sections mix with real problems', async () => {
    const bad = { ...SPEC, name: 'bad name!' } as unknown as AgentSpecV2;
    await expect(repo.writeSpec('bad', bad)).rejects.toBeInstanceOf(InvalidSpecError);
    expect(fs.existsSync(repo.specPath('bad'))).toBe(false);
  });

  it('returns undefined for a missing spec and throws for a broken one', async () => {
    expect(await repo.readSpec('nope')).toBeUndefined();
    fs.mkdirSync(repo.agentsDir(), { recursive: true });
    fs.writeFileSync(repo.specPath('broken'), 'name: [unclosed', 'utf8');
    await expect(repo.readSpec('broken')).rejects.toMatchObject({ code: 'LOUSHO_SPEC_INVALID' });
  });

  it('reads a hand-written v1 YAML as v2', async () => {
    fs.mkdirSync(repo.agentsDir(), { recursive: true });
    fs.writeFileSync(
      repo.specPath('v1bot'),
      'name: bot\nprompt: Hi there.\nprovider: { type: mock, model: m1 }\n',
      'utf8'
    );
    expect(await repo.readSpec('v1bot')).toEqual({
      version: 2,
      name: 'bot',
      model: 'mock/m1',
      instructions: 'Hi there.',
    });
  });

  it('listIds ignores non-yaml files and invalid ids, and sorts', () => {
    fs.mkdirSync(repo.agentsDir(), { recursive: true });
    for (const file of ['zeta.yaml', 'alpha.yml', 'bad..id.yaml', 'notes.txt', 'beta.yaml']) {
      fs.writeFileSync(path.join(repo.agentsDir(), file), 'name: x\n', 'utf8');
    }
    expect(repo.listIds()).toEqual(['alpha', 'beta', 'zeta']);
  });

  it('readMeta/readLayout return defaults without writing anything; both round-trip', async () => {
    await repo.writeSpec('meta', { version: 2, name: 'meta', model: 'mock/m1', instructions: 'x' } as AgentSpecV2);
    const metaPath = path.join(repo.sidecarDir('meta'), 'meta.json');
    const layoutPath = path.join(repo.sidecarDir('meta'), 'layout.json');

    const meta = await repo.readMeta('meta');
    expect(meta).toMatchObject({
      schemaVersion: 1,
      enabled: true,
      disabledAt: null,
      disabledReason: null,
      failureStreak: 0,
      labels: [],
      publishedVersion: null,
    });
    expect(meta.createdAt).toBe(repo.updatedAt('meta'));
    expect(meta.updatedAt).toBe(meta.createdAt);
    expect(fs.existsSync(metaPath)).toBe(false);

    expect(await repo.readLayout('meta')).toEqual({ schemaVersion: 1, nodes: {}, notes: [] });
    expect(fs.existsSync(layoutPath)).toBe(false);

    const customMeta: AgentMeta = { ...meta, enabled: false, labels: ['ops'], updatedAt: '2026-01-01T00:00:00.000Z' };
    await repo.writeMeta('meta', customMeta);
    expect(await repo.readMeta('meta')).toEqual(customMeta);

    const layout: CanvasLayout = {
      schemaVersion: 1,
      nodes: { agent: { x: 10, y: 20 } },
      notes: [{ id: 'n1', x: 1, y: 2, text: 'hi' }],
      viewport: { x: 0, y: 0, zoom: 1.5 },
    };
    await repo.writeLayout('meta', layout);
    expect(await repo.readLayout('meta')).toEqual(layout);
  });

  it('remove deletes spec + the three sidecars but keeps versions/ and traces/', async () => {
    await repo.writeSpec('gone', { version: 2, name: 'gone', model: 'mock/m1', instructions: 'x' } as AgentSpecV2);
    await repo.writeMeta('gone', await repo.readMeta('gone'));
    await repo.writeLayout('gone', await repo.readLayout('gone'));
    const dir = repo.sidecarDir('gone');
    fs.mkdirSync(path.join(dir, 'versions'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'traces'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'versions', 'index.jsonl'), '{}\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'traces', 't.json'), '{}', 'utf8');

    await repo.remove('gone');

    expect(fs.existsSync(repo.specPath('gone'))).toBe(false);
    for (const file of ['meta.json', 'layout.json', 'working.json']) {
      expect(fs.existsSync(path.join(dir, file))).toBe(false);
    }
    expect(fs.existsSync(path.join(dir, 'versions', 'index.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'traces', 't.json'))).toBe(true);
  });

  it('readWorkingHash matches specHash of the spec readSpec returns', async () => {
    await repo.writeSpec('hash', SPEC);
    const stored = await repo.readWorkingHash('hash');
    expect(stored).toMatch(/^sha256:/);
    expect(stored).toBe(specHash((await repo.readSpec('hash'))!));
  });
});
