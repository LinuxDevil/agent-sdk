import { defineSchedule, isDefinedSchedule, type DefinedSchedule } from '../schedules/defineSchedule';
import { loadDefaultExports } from './loadDefaultExports';

/**
 * Loads every `schedules/*.{ts,js,mjs,cjs,mts}` file under `dir` (sorted by
 * file name). Each file default-exports a `defineSchedule()` schedule; its
 * name is the `name` it set, else the file name without extension.
 */
export function loadSchedules(dir: string): Promise<DefinedSchedule[]> {
  return loadDefaultExports(
    dir,
    'schedules',
    'LOUSHY_SCHEDULE_INVALID',
    'a defineSchedule() schedule, for example ' +
      "export default defineSchedule({ cron: '0 9 * * *', prompt: 'Good morning' }).",
    isDefinedSchedule,
    (schedule, stem) => defineSchedule({ ...schedule, name: schedule.name ?? stem })
  );
}
