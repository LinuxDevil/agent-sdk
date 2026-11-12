import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import type { AgentSpecV2 } from 'lousho';
import { AgentRepo } from '../agentRepo';
import { VersionStore, type CaptureInput } from '../versionStore';
import type { VersionListItem, VersionRecord } from '../../../shared/wireTypes';

const SPEC_A: AgentSpecV2 = { version: 2, name: 'ops', model: 'mock/mock-1', instructions: 'Run the ops checks.' };
const SPEC_B: AgentSpecV2 = { ...SPEC_A, description: 'Second draft.' };

const CREATE: CaptureInput = { kind: 'create', source: 'editor' };
const UPDATE: CaptureInput = { kind: 'update', source: 'editor' };

describe('VersionStore.setSummary / onVersionWritten (L04)', () => {
  let baseDir: string;
  let repo: AgentRepo;
  let store: VersionStore;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-l04-summary-'));
    repo = new AgentRepo(baseDir);
    store = new VersionStore(repo, () => new Date('2026-02-03T04:05:06.000Z'));
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  const versionsDir = (id: string) => path.join(repo.sidecarDir(id), 'versions');
  const recordPath = (id: string, version: number) =>
    path.join(versionsDir(id), `${String(version).padStart(6, '0')}.json`);
  const indexLines = (id: string): VersionListItem[] =>
    fs
      .readFileSync(path.join(versionsDir(id), 'index.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as VersionListItem);

  it('writes the summary into the record and the index line, then refuses a second write', async () => {
    await repo.writeSpec('ops', SPEC_A);
    const item = (await store.capture('ops', CREATE))!;
    expect(item.summary).toBeNull();

    expect(await store.setSummary('ops', item.version, 'Created the agent.')).toBe(true);

    const record = JSON.parse(fs.readFileSync(recordPath('ops', item.version), 'utf8')) as VersionRecord;
    expect(record.summary).toBe('Created the agent.');
    expect(indexLines('ops').find((line) => line.version === item.version)?.summary).toBe('Created the agent.');
    expect((await store.get('ops', item.version))?.summary).toBe('Created the agent.');

    // A late second pass never overwrites.
    expect(await store.setSummary('ops', item.version, 'A different sentence.')).toBe(false);
    expect((await store.get('ops', item.version))?.summary).toBe('Created the agent.');
  });

  it('returns false for an unknown version and writes nothing', async () => {
    await repo.writeSpec('ops', SPEC_A);
    await store.capture('ops', CREATE);
    expect(await store.setSummary('ops', 99, 'Nope.')).toBe(false);
    expect(await store.setSummary('ghost', 1, 'Nope.')).toBe(false);
    expect(fs.existsSync(path.join(versionsDir('ghost'), 'index.jsonl'))).toBe(false);
  });

  it('serializes concurrent setSummary calls: exactly one wins', async () => {
    await repo.writeSpec('ops', SPEC_A);
    const item = (await store.capture('ops', CREATE))!;
    const results = await Promise.all([
      store.setSummary('ops', item.version, 'First.'),
      store.setSummary('ops', item.version, 'Second.'),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const summary = (await store.get('ops', item.version))?.summary;
    expect(['First.', 'Second.']).toContain(summary);
  });

  it('onVersionWritten fires after a successful capture with the written item, and unsubscribe stops it', async () => {
    const seen: Array<{ agentId: string; item: VersionListItem }> = [];
    const off = store.onVersionWritten((agentId, item) => seen.push({ agentId, item }));

    await repo.writeSpec('ops', SPEC_A);
    const item = (await store.capture('ops', CREATE))!;
    expect(seen).toHaveLength(1);
    expect(seen[0].agentId).toBe('ops');
    expect(seen[0].item).toEqual(item);

    off();
    await repo.writeSpec('ops', SPEC_B);
    await store.capture('ops', UPDATE);
    expect(seen).toHaveLength(1);
  });

  it('a no-op update capture notifies nobody', async () => {
    const listener = vi.fn();
    store.onVersionWritten(listener);
    await repo.writeSpec('ops', SPEC_A);
    await store.capture('ops', CREATE);
    listener.mockClear();
    await store.capture('ops', UPDATE); // identical spec + labels: skipped
    expect(listener).not.toHaveBeenCalled();
  });

  it('a throwing listener is logged, not propagated into the capture', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    store.onVersionWritten(() => {
      throw new Error('listener boom');
    });
    await repo.writeSpec('ops', SPEC_A);
    const item = await store.capture('ops', CREATE);
    expect(item).not.toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('reconcileExternalEdit notifies with the baseline item', async () => {
    const seen: VersionListItem[] = [];
    store.onVersionWritten((_id, item) => seen.push(item));
    await repo.writeSpec('ops', SPEC_A);
    // A hand edit outside Studio: the yaml hash matches no version and the
    // working.json marker, so reconcile baselines it first.
    fs.writeFileSync(repo.specPath('ops'), stringifyYaml(SPEC_B), 'utf8');
    const item = await store.reconcileExternalEdit('ops');
    expect(item?.kind).toBe('baseline');
    expect(seen.map((i) => i.kind)).toEqual(['baseline']);
  });
});
