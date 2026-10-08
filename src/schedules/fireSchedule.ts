import type { SimpleAgent } from '../createAgent';
import { ConfigurationError } from '../execution/errors';
import type { DefinedSchedule } from './defineSchedule';

/** The name a schedule runs under: its own `name`, else `schedule-<position>`. */
export function scheduleName(schedule: DefinedSchedule, index: number): string {
  return schedule.name ?? `schedule-${index + 1}`;
}

/** Agents known not to have a checkpoint store: their prompt fires stay ephemeral (as before `sessionId` was passed). */
const noCheckpointStore = new WeakSet<SimpleAgent>();

/**
 * A prompt fire as an agent turn under `sessionId` (the durable, resumable
 * `schedule-<name>` run). An agent without a checkpoint store cannot run under
 * a session id: the fire falls back to a plain turn, once - the throw happens
 * before the run starts, so nothing ran twice.
 */
async function promptTurn(agent: SimpleAgent, prompt: string, sessionId: string | undefined): Promise<void> {
  if (sessionId === undefined || noCheckpointStore.has(agent)) {
    await agent.send(prompt);
    return;
  }
  try {
    await agent.send(prompt, { sessionId });
  } catch (error) {
    if (!(error instanceof ConfigurationError && error.message.includes('checkpoint store'))) throw error;
    noCheckpointStore.add(agent);
    await agent.send(prompt);
  }
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
  else await promptTurn(agent, schedule.prompt as string, sessionId);
}
