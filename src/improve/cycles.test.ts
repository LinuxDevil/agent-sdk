import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendAudit } from './audit';
import { cooldownEnds, newCycleId, pausedBy, readCycles, usageToday, writeCycle, type HealCycle } from './cycles';

let dir: string;

const cycle = (id: string, over: Partial<HealCycle> = {}): HealCycle => ({ id, trigger: 'failures', approval: 'auto', outcome: 'applied', reason: 'Applied.', startedAt: new Date().toISOString(), tokens: 100, ...over });

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'lousho-cycles-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('cycle records', () => {
  it('ids sort by start time', () => {
    expect(newCycleId(Date.UTC(2026, 10, 9, 8, 30, 5))).toMatch(/^20261109T083005Z-[0-9a-f]{6}$/);
    expect(newCycleId(Date.UTC(2026, 10, 9)) < newCycleId(Date.UTC(2026, 10, 10))).toBe(true);
  });

  it('round-trips newest first, replaces a cycle saved twice, and skips broken files', () => {
    writeCycle(dir, cycle('20261109T080000Z-aaaaaa', { outcome: 'interrupted' }));
    writeCycle(dir, cycle('20261109T090000Z-bbbbbb'));
    writeCycle(dir, cycle('20261109T080000Z-aaaaaa', { outcome: 'pending' }));
    writeFileSync(path.join(dir, '.lousho', 'cycles', '20261109T100000Z-cccccc.json'), '{ broken');
    writeFileSync(path.join(dir, '.lousho', 'cycles', 'notes.json'), '{}');
    expect(readCycles(dir).map((item) => [item.id, item.outcome])).toEqual([
      ['20261109T090000Z-bbbbbb', 'applied'],
      ['20261109T080000Z-aaaaaa', 'pending'],
    ]);
    expect(() => writeCycle(dir, cycle('../escape'))).toThrow(/not a cycle id/);
  });

  it('refuses a symlinked cycles folder', () => {
    const elsewhere = mkdtempSync(path.join(tmpdir(), 'lousho-elsewhere-'));
    mkdirSync(path.join(dir, '.lousho'));
    symlinkSync(elsewhere, path.join(dir, '.lousho', 'cycles'));
    expect(() => readCycles(dir)).toThrow(/symlink/);
    rmSync(elsewhere, { recursive: true, force: true });
  });
});

describe('budgets, cooldown and the kill switch', () => {
  it("counts today's cycles, tokens and automatic applies only", async () => {
    const now = Date.now();
    writeCycle(dir, cycle(newCycleId(now)));
    writeCycle(dir, cycle(newCycleId(now - 2 * 86_400_000), { startedAt: new Date(now - 2 * 86_400_000).toISOString() }));
    await appendAudit(dir, { actor: 'canary', action: 'apply', reason: 'Applied.' });
    await appendAudit(dir, { actor: 'person:ana', action: 'apply', reason: 'Applied.' });
    expect(usageToday(dir, now)).toEqual({ cycles: 1, tokens: 100, applies: 1 });
  });

  it('a rollback starts a cooldown that ends after the set hours', async () => {
    const now = Date.now();
    expect(cooldownEnds(dir, 24, now)).toBeUndefined();
    await appendAudit(dir, { actor: 'guard', action: 'rollback', reason: 'Regressed.' });
    expect(cooldownEnds(dir, 24, now)).toBeGreaterThan(now + 23 * 3_600_000);
    expect(cooldownEnds(dir, 24, now + 25 * 3_600_000)).toBeUndefined();
    expect(cooldownEnds(dir, 0, now + 1000)).toBeUndefined();
  });

  it('the stop file, LOUSHO_IMPROVE=off and enabled false each pause the loop', () => {
    expect(pausedBy(dir, { enabled: true }, {})).toBeUndefined();
    expect(pausedBy(dir, { enabled: false }, {})).toMatch(/enabled to false/);
    expect(pausedBy(dir, { enabled: true }, { LOUSHO_IMPROVE: ' OFF ' })).toMatch(/LOUSHO_IMPROVE/);
    mkdirSync(path.join(dir, '.lousho'));
    writeFileSync(path.join(dir, '.lousho', 'improve.stop'), 'maintenance');
    expect(pausedBy(dir, { enabled: true }, {})).toMatch(/improve\.stop/);
  });
});
