import path from 'node:path';
import { defineSchedule, isDefinedSchedule, type DefinedSchedule } from '../schedules/defineSchedule';
import { listSorted } from './fsUtil';
import { importModule } from './importModule';

const SCHEDULE_FILE = /\.[cm]?[jt]s$/;
const NOT_A_SCHEDULE_FILE = /\.d\.[cm]?ts$|\.(?:test|spec)\./;

/**
 * Loads every `schedules/*.{ts,js,mjs,cjs,mts}` file under `dir` (sorted by
 * file name). Each file default-exports a `defineSchedule()` schedule; its
 * name is the `name` it set, else the file name without extension.
 */
export async function loadSchedules(dir: string): Promise<DefinedSchedule[]> {
  const schedulesDir = path.join(dir, 'schedules');
  const files = await listSorted(schedulesDir, (e) => e.isFile && SCHEDULE_FILE.test(e.name) && !NOT_A_SCHEDULE_FILE.test(e.name));
  const schedules: DefinedSchedule[] = [];
  for (const fileName of files) {
    const file = path.join(schedulesDir, fileName);
    const exported = (await importModule(file)).default;
    if (!isDefinedSchedule(exported)) {
      throw new Error(
        `loadAgentDir: ${file}: the default export must be a defineSchedule() schedule, for example ` +
          "export default defineSchedule({ cron: '0 9 * * *', prompt: 'Good morning' })."
      );
    }
    const name = exported.name ?? fileName.replace(SCHEDULE_FILE, '');
    schedules.push(defineSchedule({ ...exported, name }));
  }
  return schedules;
}
