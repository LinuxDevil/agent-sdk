import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { loadAgentDir, resolveAgentDir } from './index';
import { mockModel } from '../testing';

const fixture = (name: string): string => path.join(__dirname, '__fixtures__', name);

describe('schedules/ in an agent directory (LOU-P8)', () => {
  it('loads schedules/*.ts: the name defaults to the file name, an explicit name wins', async () => {
    const { schedules, manifest } = await resolveAgentDir(fixture('schedules'), { provider: mockModel(['x']) });
    expect(schedules.map((s) => [s.name, s.cron, s.timezone])).toEqual([
      ['daily-report', '0 9 * * *', undefined],
      ['cleanup', '@daily', 'UTC'],
    ]);
    expect(schedules[0].prompt).toBe('Write the daily report.');
    expect(typeof schedules[1].run).toBe('function');
    expect(manifest.schedules).toEqual(['daily-report', 'cleanup']);
  });

  it('a directory without schedules/ behaves as before', async () => {
    const { schedules, manifest } = await resolveAgentDir(fixture('full'), { provider: mockModel(['x']) });
    expect(schedules).toEqual([]);
    expect(manifest.schedules).toEqual([]);
    await expect(loadAgentDir(fixture('full'), { provider: mockModel(['x']) })).resolves.toBeDefined();
  });

  it('rejects a default export that is not a defineSchedule() schedule, naming the file', async () => {
    await expect(resolveAgentDir(fixture('err-bad-schedule'), { provider: mockModel(['x']) })).rejects.toThrow(
      /plain\.ts: the default export must be a defineSchedule\(\) schedule/
    );
  });
});
