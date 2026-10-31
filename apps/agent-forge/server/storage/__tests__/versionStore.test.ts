import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import type { AgentSpecV2 } from '@lousho/build-ai-agent';
import { AgentRepo } from '../agentRepo';
import { VersionStore, type CaptureInput } from '../versionStore';
import type { VersionListItem, VersionRecord } from '../../../shared/wireTypes';

const SPEC_A: AgentSpecV2 = { version: 2, name: 'ops', model: 'mock/mock-1', instructions: 'Run the ops checks.' };
const SPEC_B: AgentSpecV2 = { ...SPEC_A, description: 'Second draft.' };

const CREATE: CaptureInput = { kind: 'create', source: 'editor' };
const UPDATE: CaptureInput = { kind: 'update', source: 'editor' };

const FIXED = new Date('2026-02-03T04:05:06.000Z');

describe('VersionStore', () => {
  let baseDir: string;
  let repo: AgentRepo;
  let store: VersionStore;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-d03-versions-'));
    repo = new AgentRepo(baseDir);
    store = new VersionStore(repo, () => FIXED);
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  const versionsDir = (id: string) => path.join(repo.sidecarDir(id), 'versions');

  /** Every index.jsonl line parsed (the tests only ever read whole, well-formed lines). */
  const indexLines = (id: string): VersionListItem[] => {
    const indexPath = path.join(versionsDir(id), 'index.jsonl');
    if (!fs.existsSync(indexPath)) return [];
    return fs
      .readFileSync(indexPath, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as VersionListItem);
  };

  /** Overwrite `<id>.yaml` on disk, the way a hand edit outside Studio does. */
  const handEdit = (id: string, spec: AgentSpecV2) => {
    fs.writeFileSync(repo.specPath(id), stringifyYaml(spec), 'utf8');
  };

  it('first capture writes 000001.json and one index line listing every non-empty field', async () => {
    await repo.writeSpec('ops', SPEC_A);
    const item = await store.capture('ops', CREATE);
    expect(item).not.toBeNull();
    expect(item).toMatchObject({
      version: 1,
      kind: 'create',
      source: 'editor',
      changedFields: ['name', 'model', 'instructions'],
      restoredFromVersion: null,
      summary: null,
      requestText: null,
      authorSessionId: null,
      createdAt: FIXED.toISOString(),
    });
    expect(item!.specHash).toMatch(/^sha256:/);

    const record = JSON.parse(
      fs.readFileSync(path.join(versionsDir('ops'), '000001.json'), 'utf8')
    ) as VersionRecord;
    expect(record.snapshot).toEqual({ spec: SPEC_A, labels: [] });
    expect(indexLines('ops')).toEqual([item]);
  });

  it('throws when the agent has no spec file', async () => {
    await expect(store.capture('ghost', UPDATE)).rejects.toThrow("No saved agent 'ghost'");
  });

  it('skips a no-op update: a second identical capture returns null and writes nothing', async () => {
    await repo.writeSpec('ops', SPEC_A);
    await store.capture('ops', UPDATE);
    const filesBefore = fs.readdirSync(versionsDir('ops')).sort();
    expect(await store.capture('ops', UPDATE)).toBeNull();
    expect(fs.readdirSync(versionsDir('ops')).sort()).toEqual(filesBefore);
    expect(indexLines('ops')).toHaveLength(1);
  });

  it('does not skip when only the labels changed; changedFields is ["labels"]', async () => {
    await repo.writeSpec('ops', SPEC_A);
    await store.capture('ops', UPDATE);
    const meta = await repo.readMeta('ops');
    await repo.writeMeta('ops', { ...meta, labels: ['ops', 'nightly'] });
    const item = await store.capture('ops', UPDATE);
    expect(item).not.toBeNull();
    expect(item!.version).toBe(2);
    expect(item!.changedFields).toEqual(['labels']);
    expect((await store.get('ops', 2))!.snapshot.labels).toEqual(['ops', 'nightly']);
  });

  it.each([
    { kind: 'restore', source: 'restore', restoredFromVersion: 1 },
    { kind: 'publish', source: 'editor' },
    { kind: 'baseline', source: 'external_file_edit' },
    { kind: 'create', source: 'editor' },
  ] as const)('kind "$kind" is never skipped', async (input) => {
    await repo.writeSpec('ops', SPEC_A);
    await store.capture('ops', UPDATE);
    const item = await store.capture('ops', input);
    expect(item).not.toBeNull();
    expect(item).toMatchObject({ version: 2, kind: input.kind, source: input.source });
    expect(indexLines('ops')).toHaveLength(2);
  });

  it('keeps restoredFromVersion on a restore', async () => {
    await repo.writeSpec('ops', SPEC_A);
    await store.capture('ops', UPDATE);
    const item = await store.capture('ops', { kind: 'restore', source: 'restore', restoredFromVersion: 1 });
    expect(item!.restoredFromVersion).toBe(1);
  });

  it('list() is newest first, latest() the newest, get() returns the record with its snapshot', async () => {
    await repo.writeSpec('ops', SPEC_A);
    await store.capture('ops', UPDATE);
    await repo.writeSpec('ops', SPEC_B);
    await store.capture('ops', UPDATE);

    expect((await store.list('ops')).map((i) => i.version)).toEqual([2, 1]);
    expect((await store.latest('ops'))!.version).toBe(2);
    expect((await store.get('ops', 1))!.snapshot.spec).toEqual(SPEC_A);
    expect((await store.get('ops', 2))!.snapshot.spec).toEqual(SPEC_B);
    expect(await store.get('ops', 99)).toBeUndefined();
    expect(await store.list('ghost')).toEqual([]);
    expect(await store.latest('ghost')).toBeUndefined();
  });

  it('ignores a truncated last index line and numbers the next capture after the last good line', async () => {
    await repo.writeSpec('ops', SPEC_A);
    await store.capture('ops', UPDATE);
    // A crash can leave a partial last line behind.
    fs.appendFileSync(path.join(versionsDir('ops'), 'index.jsonl'), '{"version":2,"kind":"upda');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect((await store.list('ops')).map((i) => i.version)).toEqual([1]);
    expect(warn).toHaveBeenCalledOnce();

    await repo.writeSpec('ops', SPEC_B);
    const item = await store.capture('ops', UPDATE);
    expect(item!.version).toBe(2);
    warn.mockRestore();
  });

  describe('reconcileExternalEdit', () => {
    it('is a no-op right after writeSpec (Studio wrote the file itself)', async () => {
      await repo.writeSpec('ops', SPEC_A);
      expect(await store.reconcileExternalEdit('ops')).toBeNull();
      expect(indexLines('ops')).toEqual([]);
    });

    it('returns null when the agent has no spec file', async () => {
      expect(await store.reconcileExternalEdit('ghost')).toBeNull();
    });

    it('baselines a hand edit, then is a no-op on the next call', async () => {
      await repo.writeSpec('ops', SPEC_A);
      handEdit('ops', SPEC_B);
      const item = await store.reconcileExternalEdit('ops');
      expect(item).toMatchObject({ version: 1, kind: 'baseline', source: 'external_file_edit' });
      expect((await store.get('ops', 1))!.snapshot.spec).toEqual(SPEC_B);
      expect(await store.reconcileExternalEdit('ops')).toBeNull();
      expect(indexLines('ops')).toHaveLength(1);
    });

    it('is a no-op when the hand edit equals an older version', async () => {
      await repo.writeSpec('ops', SPEC_A);
      await store.capture('ops', UPDATE);
      await repo.writeSpec('ops', SPEC_B);
      await store.capture('ops', UPDATE);
      handEdit('ops', SPEC_A);
      expect(await store.reconcileExternalEdit('ops')).toBeNull();
      expect(indexLines('ops')).toHaveLength(2);
    });

    it('baselines a legacy agent that only has a yaml file (no index, no working.json)', async () => {
      fs.mkdirSync(repo.agentsDir(), { recursive: true });
      handEdit('legacy', SPEC_A);
      const item = await store.reconcileExternalEdit('legacy');
      expect(item).toMatchObject({ version: 1, kind: 'baseline', source: 'external_file_edit' });
      expect(indexLines('legacy')).toHaveLength(1);
    });
  });

  describe('requestText clamp', () => {
    it('collapses whitespace runs and trims', async () => {
      await repo.writeSpec('ops', SPEC_A);
      const item = await store.capture('ops', { ...UPDATE, requestText: '  add\n\n  a   guardrail ' });
      expect(item!.requestText).toBe('add a guardrail');
    });

    it('cuts a 1000-char requestText to 400 chars ending in …', async () => {
      await repo.writeSpec('ops', SPEC_A);
      const item = await store.capture('ops', { ...UPDATE, requestText: 'x'.repeat(1000) });
      expect(item!.requestText).toHaveLength(400);
      expect(item!.requestText).toBe(`${'x'.repeat(399)}…`);
    });

    it('stores null for empty or absent requestText', async () => {
      await repo.writeSpec('ops', SPEC_A);
      expect((await store.capture('ops', { ...UPDATE, requestText: '   ' }))!.requestText).toBeNull();
      await repo.writeSpec('ops', SPEC_B);
      expect((await store.capture('ops', UPDATE))!.requestText).toBeNull();
    });
  });
});
