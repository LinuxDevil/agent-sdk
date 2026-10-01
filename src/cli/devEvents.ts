/**
 * Events for `loushy dev` responses that are not a live `stream()` (LOU-D32):
 * a request that failed while streaming is answered with `error` + `run.done`.
 * (Approval continuations stream live from `agent.approvals.streamResolve()`,
 * LOU-D32.2.)
 */
import { AGENT_EVENT_SCHEMA_VERSION, type AgentEvent, type AgentEventPayload } from '../execution/agentEvents';
import { newId } from '../utils/id';

/** `payloads` as one run's events: a shared `runId`, `seq` 0, 1, 2..., `timestamp` and `v` filled in. */
function runEvents(payloads: AgentEventPayload[]): AgentEvent[] {
  const runId = newId();
  return payloads.map(
    (payload, seq) => ({ ...payload, runId, seq, timestamp: new Date().toISOString(), v: AGENT_EVENT_SCHEMA_VERSION }) as AgentEvent
  );
}

/** `error` then `run.done`, for a request that failed while streaming. */
export function errorEvents(error: unknown): AgentEvent[] {
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : 'Error';
  return runEvents([
    { type: 'error', error: { name, message } },
    { type: 'run.done', finishReason: 'error', text: '' },
  ]);
}
