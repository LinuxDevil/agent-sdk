import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentRepo } from '../agentRepo';
import { DraftStore, DraftMismatchError, NoDraftError, type NewDraftInput } from '../draftStore';

const INPUT: NewDraftInput = {
  patch: { description: 'Triage faster.' },
  origin: 'author',
  reason: 'Tighten the description.',
  baseVersion: 3,
  baseSpecHash: 'sha256:abc',
};

let NOW = new Date('2026-02-03T04:05:06.000Z');
const FIXED = () => NOW;

describe('DraftStore', () => {
  let baseDir: string;
  let repo: AgentRepo;
  let store: DraftStore;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-d04-drafts-'));
    repo = new AgentRepo(baseDir);
    NOW = new Date('2026-02-03T04:05:06.000Z');
    store = new DraftStore(repo, FIXED);
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  const draftsDir = (id: string) => path.join(repo.sidecarDir(id), 'drafts');
  const currentPath = (id: string) => path.join(draftsDir(id), 'current.json');
  const historyPath = (id: string, draftId: string) => path.join(draftsDir(id), 'history', `${draftId}.json`);

  it('create writes a pending draft to current.json and current() returns it', async () => {
    const { draft, replaced } = await store.create('ops', INPUT);

    expect(replaced).toBeNull();
    expect(draft).toMatchObject({
      agentId: 'ops',
      status: 'pending',
      origin: 'author',
      patch: INPUT.patch,
      reason: INPUT.reason,
      baseVersion: 3,
      baseSpecHash: 'sha256:abc',
      autoReview: null,
      note: null,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      respondedAt: null,
    });
    expect(draft.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await store.current('ops')).toEqual(draft);
    expect(JSON.parse(fs.readFileSync(currentPath('ops'), 'utf8'))).toEqual(draft);
    expect(await store.current('ghost')).toBeUndefined();
  });

  it('a second create withdraws the first into history and returns it as `replaced`', async () => {
    const first = (await store.create('ops', INPUT)).draft;
    NOW = new Date('2026-02-03T04:06:06.000Z');
    const { draft: second, replaced } = await store.create('ops', { ...INPUT, reason: 'Better wording.' });

    // Only the second draft is pending on disk.
    expect(await store.current('ops')).toEqual(second);
    expect(JSON.parse(fs.readFileSync(currentPath('ops'), 'utf8'))).toEqual(second);

    // The first moved to history as withdrawn, stamped with the new clock time.
    expect(replaced).not.toBeNull();
    expect(replaced!.id).toBe(first.id);
    expect(replaced).toMatchObject({
      status: 'withdrawn',
      respondedAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
    expect(JSON.parse(fs.readFileSync(historyPath('ops', first.id), 'utf8'))).toEqual(replaced);
    expect((await store.history('ops')).map((d) => d.id)).toEqual([first.id]);
  });

  it('settle approved with a note removes current.json and records the note + respondedAt in history', async () => {
    const { draft } = await store.create('ops', INPUT);
    NOW = new Date('2026-02-03T04:07:00.000Z');

    const settled = await store.settle('ops', 'approved', { note: 'Looks right.' });
    expect(settled).toMatchObject({
      id: draft.id,
      status: 'approved',
      note: 'Looks right.',
      respondedAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
    expect(fs.existsSync(currentPath('ops'))).toBe(false);
    expect(await store.current('ops')).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(historyPath('ops', draft.id), 'utf8'))).toEqual(settled);
    expect(await store.history('ops')).toEqual([settled]);
  });

  it('settle with a matching draftId settles; a wrong draftId throws DraftMismatchError and changes nothing', async () => {
    const { draft } = await store.create('ops', INPUT);

    await expect(store.settle('ops', 'rejected', { draftId: 'not-the-id' })).rejects.toBeInstanceOf(
      DraftMismatchError
    );
    await expect(store.settle('ops', 'rejected', { draftId: 'not-the-id' })).rejects.toMatchObject({
      code: 'LOUSHO_DRAFT_STALE',
    });

    // Nothing moved: current.json still holds the pending draft, history is empty.
    expect(await store.current('ops')).toEqual(draft);
    expect(fs.existsSync(path.join(draftsDir('ops'), 'history'))).toBe(false);
    expect(await store.history('ops')).toEqual([]);

    const settled = await store.settle('ops', 'rejected', { draftId: draft.id });
    expect(settled.status).toBe('rejected');
    expect(await store.current('ops')).toBeUndefined();
  });

  it('settle with no current draft throws NoDraftError', async () => {
    await expect(store.settle('ops', 'approved')).rejects.toBeInstanceOf(NoDraftError);
    await expect(store.settle('ops', 'approved')).rejects.toMatchObject({ code: 'LOUSHO_DRAFT_NOT_FOUND' });
  });

  it('history is newest respondedAt first, mixing settles and auto-withdrawals', async () => {
    NOW = new Date('2026-02-03T04:01:00.000Z');
    const a = (await store.create('ops', { ...INPUT, reason: 'a' })).draft;
    NOW = new Date('2026-02-03T04:02:00.000Z');
    const b = (await store.create('ops', { ...INPUT, reason: 'b' })).draft; // withdraws a at 04:02
    NOW = new Date('2026-02-03T04:03:00.000Z');
    const c = (await store.create('ops', { ...INPUT, reason: 'c' })).draft; // withdraws b at 04:03
    NOW = new Date('2026-02-03T04:04:00.000Z');
    await store.settle('ops', 'approved'); // settles c at 04:04

    const history = await store.history('ops');
    expect(history.map((d) => d.id)).toEqual([c.id, b.id, a.id]);
    expect(history.map((d) => d.status)).toEqual(['approved', 'withdrawn', 'withdrawn']);
    expect(history.map((d) => d.respondedAt)).toEqual([
      '2026-02-03T04:04:00.000Z',
      '2026-02-03T04:03:00.000Z',
      '2026-02-03T04:02:00.000Z',
    ]);
  });

  it('unparsable history files are skipped with a warning', async () => {
    await store.create('ops', INPUT);
    const settled = await store.settle('ops', 'approved');
    fs.mkdirSync(path.join(draftsDir('ops'), 'history'), { recursive: true });
    fs.writeFileSync(path.join(draftsDir('ops'), 'history', 'broken.json'), '{not json');
    fs.writeFileSync(path.join(draftsDir('ops'), 'history', 'note.txt'), 'ignored - not .json');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(await store.history('ops')).toEqual([settled]);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('drafts of different agents do not share current.json', async () => {
    const a = (await store.create('ops', INPUT)).draft;
    const b = (await store.create('billing', INPUT)).draft;
    expect(await store.current('ops')).toEqual(a);
    expect(await store.current('billing')).toEqual(b);
  });
});
