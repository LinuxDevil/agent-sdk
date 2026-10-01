import type { SimpleAgent } from '../createAgent';
import type { DefinedSchedule } from './defineSchedule';

/** The name a schedule runs under: its own `name`, else `schedule-<position>`. */
export function scheduleName(schedule: DefinedSchedule, index: number): string {
  return schedule.name ?? `schedule-${index + 1}`;
}

/** One fire of `schedule`: its `run` function, or its prompt as a turn (under `sessionId` when given). */
export async function fireSchedule(
  agent: SimpleAgent,
  schedule: DefinedSchedule,
  name: string,
  firedAt: Date,
  sessionId?: string
): Promise<void> {
  if (schedule.run) await schedule.run({ agent, firedAt, name });
  else await agent.send(schedule.prompt as string, sessionId === undefined ? undefined : { sessionId });
}
