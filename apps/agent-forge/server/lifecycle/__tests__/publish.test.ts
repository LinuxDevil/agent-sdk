import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentSpecV2 } from '@linuxdevil/lousho';
import type { AgentMeta, StudioEvent, VersionListItem } from '../../../shared/wireTypes';
import { StudioEventBus } from '../../events/eventBus';
import { AgentRepo } from '../../storage/agentRepo';
import { specHash } from '../../storage/specHash';
import { VersionStore } from '../../storage/versionStore';
import { parse as parseYaml } from 'yaml';
import { PublishError, publishAgent, publishStateOf, readPublishedSpec } from '../publish';
import { publishedSpecPath } from '../../deployRunner';

const AGENT = 'ops';
const SPEC_A: AgentSpecV2 = { version: 2, name: 'ops', model: 'mock/mock-1', instructions: 'Check the queues.' };
const SPEC_B: AgentSpecV2 = { ...SPEC_A, description: 'Second draft.' };
const SPEC_C: AgentSpecV2 = { ...SPEC_A, description: 'Third draft.' };

/** Writes versions v1..vN by capturing successive working copies. */
async function seedVersions(repo: AgentRepo, versions: VersionStore, specs: AgentSpecV2[]): Promise<void> {
  for (const spec of specs) {
    await repo.writeSpec(AGENT, spec);
    await versions.capture(AGENT, { kind: 'create', source: 'editor' });
  }
}

describe('publishAgent', () => {
  let dir: string;
  let repo: AgentRepo;
  let versions: VersionStore;
  let events: StudioEventBus;
  let published: StudioEvent[];
  let deps: { repo: AgentRepo; versions: VersionStore; events: StudioEventBus; baseDir: string };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-l14a-publish-'));
    repo = new AgentRepo(dir);
    versions = new VersionStore(repo);
    events = new StudioEventBus();
    published = [];
    events.subscribe((event) => published.push(event));
    deps = { repo, versions, events, baseDir: dir };
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const metaEvents = () => published.filter((e) => e.type === 'agent.changed' && e.reason === 'meta');

  it('pins the latest version without writing a new one when the working copy is unchanged', async () => {
    await seedVersions(repo, versions, [SPEC_A, SPEC_B, SPEC_C]);
    const result = await publishAgent(AGENT, {}, deps);
    expect(result).toEqual({ publishedVersion: 3 });
    expect((await versions.list(AGENT)).map((v) => v.version)).toEqual([3, 2, 1]);
    expect((await repo.readMeta(AGENT)).publishedVersion).toBe(3);
    expect(metaEvents()).toHaveLength(1);
  });

  it('writes a kind:publish version when the working copy changed since the latest version', async () => {
    await seedVersions(repo, versions, [SPEC_A, SPEC_B]);
    await repo.writeSpec(AGENT, SPEC_C);
    const result = await publishAgent(AGENT, {}, deps);
    expect(result).toEqual({ publishedVersion: 3 });
    const list = await versions.list(AGENT);
    expect(list[0]).toMatchObject({ version: 3, kind: 'publish', source: 'editor' });
    expect((await repo.readMeta(AGENT)).publishedVersion).toBe(3);
  });

  it('pins an explicit version even when newer ones exist, and repinning is a no-op', async () => {
    await seedVersions(repo, versions, [SPEC_A, SPEC_B, SPEC_C]);
    expect(await publishAgent(AGENT, { version: 2 }, deps)).toEqual({ publishedVersion: 2 });
    expect((await versions.list(AGENT))).toHaveLength(3);
    expect(metaEvents()).toHaveLength(1);
    // Republishing the pinned version: same answer, no meta write, no event.
    expect(await publishAgent(AGENT, { version: 2 }, deps)).toEqual({ publishedVersion: 2 });
    expect(metaEvents()).toHaveLength(1);
    expect((await repo.readMeta(AGENT)).publishedVersion).toBe(2);
  });

  it('emits one meta event per pointer move', async () => {
    await seedVersions(repo, versions, [SPEC_A, SPEC_B]);
    await publishAgent(AGENT, { version: 1 }, deps);
    await publishAgent(AGENT, { version: 2 }, deps);
    await publishAgent(AGENT, { version: 2 }, deps);
    expect(metaEvents()).toHaveLength(2);
  });

  it('writes published.yaml for the pinned snapshot and rewrites it when the pointer moves back', async () => {
    // The v1 projection drops v2-only fields, so the drafts differ in
    // `instructions` (which projects to the v1 `prompt`).
    const first: AgentSpecV2 = { version: 2, name: 'ops', model: 'mock/mock-1', instructions: 'First published.' };
    const second: AgentSpecV2 = { ...first, instructions: 'Second published.' };
    const snapshotPath = publishedSpecPath(dir, AGENT);
    await seedVersions(repo, versions, [first, second]);

    await publishAgent(AGENT, { version: 2 }, deps);
    let fed = parseYaml(fs.readFileSync(snapshotPath, 'utf8')) as Record<string, unknown>;
    expect(fed).toMatchObject({ name: 'ops', prompt: 'Second published.' });

    await publishAgent(AGENT, { version: 1 }, deps);
    fed = parseYaml(fs.readFileSync(snapshotPath, 'utf8')) as Record<string, unknown>;
    expect(fed).toMatchObject({ name: 'ops', prompt: 'First published.' });
  });

  it('keeps concurrent publishes consistent', async () => {
    await seedVersions(repo, versions, [SPEC_A, SPEC_B]);
    await repo.writeSpec(AGENT, SPEC_C);
    const [a, b] = await Promise.all([publishAgent(AGENT, {}, deps), publishAgent(AGENT, {}, deps)]);
    expect(a.publishedVersion).toBe(b.publishedVersion);
    const list = await versions.list(AGENT);
    // The first publish writes v3 (kind publish); the second sees the working
    // copy already equals it and pins v3 without another write.
    expect(list.filter((v) => v.kind === 'publish')).toHaveLength(1);
    expect((await repo.readMeta(AGENT)).publishedVersion).toBe(a.publishedVersion);
  });

  it('rejects an unknown agent and an unknown version', async () => {
    await seedVersions(repo, versions, [SPEC_A]);
    await expect(publishAgent('ghost', {}, deps)).rejects.toMatchObject({
      status: 404,
      code: 'LOUSHO_AGENT_NOT_FOUND',
    });
    await expect(publishAgent(AGENT, { version: 99 }, deps)).rejects.toMatchObject({
      status: 404,
      code: 'LOUSHO_VERSION_NOT_FOUND',
    });
    await expect(publishAgent(AGENT, { version: 99 }, deps)).rejects.toBeInstanceOf(PublishError);
  });
});

describe('readPublishedSpec', () => {
  let dir: string;
  let repo: AgentRepo;
  let versions: VersionStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-l14a-pubspec-'));
    repo = new AgentRepo(dir);
    versions = new VersionStore(repo);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns the pinned snapshot, not the drifted working copy', async () => {
    await seedVersions(repo, versions, [SPEC_A, SPEC_B]);
    await publishAgent(AGENT, { version: 1 }, { repo, versions, events: new StudioEventBus(), baseDir: dir });
    await repo.writeSpec(AGENT, SPEC_C);
    const published = await readPublishedSpec(AGENT, { repo, versions });
    const v1 = await versions.get(AGENT, 1);
    expect(published?.version).toBe(1);
    expect(published?.spec).toEqual(v1?.snapshot.spec);
    expect(published?.spec).not.toMatchObject({ description: SPEC_C.description });
  });

  it('is undefined when nothing is published or the pinned record is gone', async () => {
    await seedVersions(repo, versions, [SPEC_A]);
    expect(await readPublishedSpec(AGENT, { repo, versions })).toBeUndefined();
    // A dangling pointer (meta edited by hand) also reads as unpublished.
    const meta = await repo.readMeta(AGENT);
    await repo.writeMeta(AGENT, { ...meta, publishedVersion: 42 });
    expect(await readPublishedSpec(AGENT, { repo, versions })).toBeUndefined();
  });
});

describe('publishStateOf', () => {
  const meta = (publishedVersion: number | null): AgentMeta => ({
    schemaVersion: 1,
    enabled: true,
    disabledAt: null,
    disabledReason: null,
    failureStreak: 0,
    labels: [],
    publishedVersion,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
  const item: VersionListItem = {
    version: 2,
    kind: 'update',
    source: 'editor',
    changedFields: [],
    restoredFromVersion: null,
    summary: null,
    requestText: null,
    authorSessionId: null,
    specHash: 'hash-b',
    createdAt: '2026-02-02T00:00:00.000Z',
  };

  it('reports drift between the working copy and the pinned version', () => {
    expect(publishStateOf(meta(2), 'hash-b', item)).toEqual({
      version: 2,
      matchesWorkingCopy: true,
      publishedAt: '2026-02-02T00:00:00.000Z',
    });
    expect(publishStateOf(meta(2), 'hash-c', item).matchesWorkingCopy).toBe(false);
    expect(publishStateOf(meta(2), 'hash-b', undefined)).toEqual({
      version: 2,
      matchesWorkingCopy: false,
      publishedAt: null,
    });
  });

  it('is all-null/false when nothing is published', () => {
    expect(publishStateOf(meta(null), 'hash-b', undefined)).toEqual({
      version: null,
      matchesWorkingCopy: false,
      publishedAt: null,
    });
    // Even if a caller passes an item, a null pointer never matches.
    expect(publishStateOf(meta(null), 'hash-b', item).matchesWorkingCopy).toBe(false);
  });

  it('specHash distinguishes working copies', () => {
    expect(specHash(SPEC_A)).not.toBe(specHash(SPEC_B));
    expect(specHash(SPEC_A)).toBe(specHash({ ...SPEC_A }));
  });
});
