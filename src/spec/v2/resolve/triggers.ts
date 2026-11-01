/**
 * triggersFromSpec(): `spec.triggers` as what a plain Node process can run —
 * today, the `cron` entries as `startSchedules()` schedules (through
 * `specSchedules`, the same conversion the worker and the node-server use),
 * everything else listed in `notStarted` so the host can say once where they
 * do run (`lousho dev` logs that Studio runs them). A `chat` trigger needs no
 * runtime: it is the test pane and the HTTP API, so it is dropped silently.
 * No host needed: schedules are plain data. Browser-safe: no `node:*` imports.
 */
import type { DefinedSchedule } from '../../../schedules/defineSchedule';
import { specSchedules } from '../../../schedules/specSchedules';
import type { TriggerSpec } from '../triggers';

/** What a spec's triggers start in a plain Node process: today, its cron triggers as schedules. */
export interface SpecTriggers {
  /** The `DefinedSchedule`s `startSchedules()` runs — one per `type: 'cron'` trigger. */
  schedules: DefinedSchedule[];
  /** Triggers this process does not run (webhook, channel, agent), so dev can say so once. */
  notStarted: Array<{ id: string; type: TriggerSpec['type'] }>;
}

/**
 * v2 triggers → schedules (`name` = trigger id, `prompt`, `timezone`,
 * `sharedSession`); triggers this process does not run are listed in
 * `notStarted`. An invalid cron trigger throws `LOUSHO_SCHEDULE_INVALID`
 * naming it (from `specSchedules`).
 */
export function triggersFromSpec(triggers: readonly TriggerSpec[] | undefined): SpecTriggers {
  return {
    schedules: specSchedules(triggers),
    notStarted: (triggers ?? [])
      .filter((trigger) => trigger.type === 'webhook' || trigger.type === 'channel' || trigger.type === 'agent')
      .map((trigger) => ({ id: trigger.id, type: trigger.type })),
  };
}
