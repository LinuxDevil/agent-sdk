import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { improveAgent, type Harness, type ImproveOptions, type ProbeRun } from 'lousho/improve';
import { mockModel, type MockTurn } from 'lousho/testing';
import { cacheKey, cachedProbe, emptyCounts } from './probeCache';
import { assertRowModel, replayRow, type RecordedRow } from './replayRows';

const BASE: Harness = { instructions: 'Fix the bug.', skills: {} };
const FIXED: Harness = { instructions: 'Fix the bug. Never call new Date for today.', skills: {} };
const scored = (passed: boolean | null): ProbeRun => ({ passed, transcript: 'ran', tokens: 10, ended: 'stop' });
const write = (content: string): MockTurn => ({ toolCalls: [{ name: 'write_file', args: { path: 'harness/instructions.md', content } }] });

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'replay-'));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('probe cache', () => {
  it('cacheKey changes with model, salt, case, repeat and harness, but not with skill order', () => {
    const skills = { a: { description: 'A', content: 'a' }, b: { description: 'B', content: 'b' } };
    const parts = { model: 'm', salt: 's', caseId: 'c', repeat: 0, harness: { instructions: 'i', skills } };
    const key = cacheKey(parts);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(cacheKey({ ...parts, model: 'm2' })).not.toBe(key);
    expect(cacheKey({ ...parts, salt: 's2' })).not.toBe(key);
    expect(cacheKey({ ...parts, caseId: 'c2' })).not.toBe(key);
    expect(cacheKey({ ...parts, repeat: 1 })).not.toBe(key);
    expect(cacheKey({ ...parts, harness: { instructions: 'j', skills } })).not.toBe(key);
    expect(cacheKey({ ...parts, harness: { instructions: 'i', skills: { b: skills.b, a: skills.a } } })).toBe(key);
  });

  it('cachedProbe runs a miss once, serves the repeat from disk, and never caches an unscored run', async () => {
    const dir = tempDir();
    const probe = vi.fn(async () => scored(true));
    const counts = emptyCounts();
    const cached = cachedProbe(probe, { dir, model: 'm', salt: 's', counts });
    expect(await cached(BASE, 'c', 0)).toEqual(scored(true));
    expect(await cached(BASE, 'c', 0)).toEqual(scored(true));
    expect(probe).toHaveBeenCalledTimes(1);
    expect(counts).toEqual({ planned: 2, run: 1, cached: 1, excluded: 0 });

    const unscored = vi.fn(async () => scored(null));
    const unscoredCounts = emptyCounts();
    const retrying = cachedProbe(unscored, { dir, model: 'm', salt: 'other', counts: unscoredCounts });
    await retrying(BASE, 'c', 0);
    await retrying(BASE, 'c', 0);
    expect(unscored).toHaveBeenCalledTimes(2);
    expect(unscoredCounts.excluded).toBe(2);
  });

  it('cachedProbe treats an unparsable cache file as a miss and rewrites it whole', async () => {
    const dir = tempDir();
    const file = path.join(dir, `${cacheKey({ model: 'm', salt: 's', caseId: 'c', repeat: 0, harness: BASE })}.json`);
    writeFileSync(file, '{"passed":tr');
    const probe = vi.fn(async () => scored(true));
    const counts = emptyCounts();
    expect(await cachedProbe(probe, { dir, model: 'm', salt: 's', counts })(BASE, 'c', 0)).toEqual(scored(true));
    expect(probe).toHaveBeenCalledTimes(1);
    expect(counts).toMatchObject({ run: 1, cached: 0 });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(scored(true));
    expect(readdirSync(dir)).toEqual([path.basename(file)]);
  });

  it('a distinct cachedProbe gives the gate fresh runs when the composer repeats the domain candidate', async () => {
    const dir = tempDir();
    const turns = ['<notes>KEEP_BASE.</notes>', write(FIXED.instructions), '<notes>Fixed.</notes>', write(FIXED.instructions), '<notes>Composed.</notes>'];
    const attempt = async (probe: ImproveOptions['probe']) =>
      improveAgent({ harness: BASE, cases: ['c'], probe: cachedProbe(probe, { dir, model: 'm', salt: 'attempt-0', counts: emptyCounts(), distinct: true }), editor: { provider: mockModel(turns) }, repeats: 2 });

    const probe = vi.fn(async (harness: Harness) => scored(harness.instructions.includes('new Date')));
    const result = await attempt(probe);
    expect(result.candidates?.compose).toEqual(result.candidates?.domain);
    expect(probe.mock.calls.filter(([harness]) => harness.instructions === FIXED.instructions)).toHaveLength(2 * 2 * 1);

    const again = vi.fn(probe);
    await attempt(again);
    expect(again).not.toHaveBeenCalled();
  });
});

describe('assertRowModel', () => {
  it('accepts a row recorded with the same model, or with none, and refuses another model', () => {
    const row: RecordedRow = { attempt: 3, cases: ['c'], holdout: [], model: 'm', date: 'd', baseHarness: BASE };
    expect(() => assertRowModel(row, 'm')).not.toThrow();
    expect(() => assertRowModel({ attempt: 3 }, 'other')).not.toThrow();
    expect(() => assertRowModel(row, 'other')).toThrow('row 3 was recorded with m');
  });
});

describe('replayRow', () => {
  it('replay reproduces stored confirmations from the cache with no new runs', async () => {
    const dir = tempDir();
    const row: RecordedRow = {
      attempt: 0,
      cases: ['add-months'],
      holdout: [],
      model: 'm',
      date: '2026-11-07',
      baseHarness: BASE,
      candidates: { invariant: structuredClone(BASE), domain: FIXED, compose: FIXED },
    };
    const fake: ImproveOptions['probe'] = async (harness) => scored(harness.instructions.includes('new Date'));
    const expected = [
      { attempt: 0, label: 'domain', passed: 6, scored: 6, containsFix: true },
      { attempt: 0, label: 'compose', passed: 6, scored: 6, containsFix: true },
    ];

    const first = emptyCounts();
    expect(await replayRow(row, cachedProbe(fake, { dir, model: 'm', salt: 'confirm-0', counts: first }), 6)).toEqual(expected);
    expect(first).toMatchObject({ run: 6, cached: 6 });

    const second = emptyCounts();
    const probe = vi.fn(fake);
    expect(await replayRow(row, cachedProbe(probe, { dir, model: 'm', salt: 'confirm-0', counts: second }), 6)).toEqual(expected);
    expect(second).toMatchObject({ run: 0, cached: 12 });
    expect(probe).not.toHaveBeenCalled();
  });

  it('replays nothing for a row without candidates, and calls a low pass rate no fix', async () => {
    const probe = vi.fn(async () => scored(false));
    expect(await replayRow({ attempt: 1, cases: ['c'], holdout: [], model: 'm', date: 'd', baseHarness: BASE }, probe, 2)).toEqual([]);
    const row: RecordedRow = { attempt: 1, cases: ['c'], holdout: [], model: 'm', date: 'd', baseHarness: BASE, candidates: { invariant: FIXED, domain: BASE, compose: BASE } };
    expect(await replayRow(row, probe, 2)).toEqual([{ attempt: 1, label: 'invariant', passed: 0, scored: 2, containsFix: false }]);
  });
});
