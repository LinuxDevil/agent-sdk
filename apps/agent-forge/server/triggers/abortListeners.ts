/**
 * Abort listeners (R03b core, consumed by the channel path in R08b and by
 * the webhook route in R03b): when an inbound webhook/channel event
 * arrives, every `spec.abortListeners` entry whose `when` safeExpression
 * is strictly `true` over `{ event }` cancels the matching queued or
 * running runs of the trigger it watches (`match` pairs the event with
 * each candidate run's own event, also strictly `true`).
 *
 * All of an agent's listeners evaluate on every inbound event,
 * independently of which trigger delivered it - the listener's
 * `triggerId` selects which RUNS are candidates, not which events count.
 *
 * Truthiness is strict `=== true`: a listener never fires on a non-empty
 * string or any other truthy value. An `ExpressionError` at run time logs
 * `Abort listener <id> failed: <reason>` and skips that listener - it
 * never blocks the dispatch. Event bodies are never logged (they may
 * carry secrets); only listener ids and expressions are.
 */
import type { AgentSpecV2 } from '@linuxdevil/lousho';
import { evaluateSafeExpression, ExpressionError } from '@linuxdevil/lousho/flows';

import type { HostRun, TriggerHost } from './triggerHost';

export interface AbortOutcome {
  listenerId: string;
  cancelled: Array<{ runKey: string; status: 'queued' | 'running' }>;
}

/** What {@link applyAbortListeners} needs: the spec, the delivering trigger, the event, and the host's run views. */
export interface AbortListenerInput {
  spec: AgentSpecV2;
  agentId: string;
  /** The trigger that delivered the event (its own run is not queued yet, so it cannot self-cancel). */
  triggerId: string;
  event: unknown;
  host: Pick<TriggerHost, 'runsOf' | 'cancel'>;
  log: (agentId: string, message: string, level?: 'info' | 'warn' | 'error') => void;
}

/** The run statuses a listener `scope` may cancel. */
function scopeAllows(scope: string, run: HostRun): boolean {
  if (scope === 'both') return true;
  return run.status === scope;
}

/**
 * `evaluateSafeExpression(...) === true`, or `undefined` when the
 * expression itself fails - an {@link ExpressionError} logs
 * `Abort listener <id> failed: <reason>` and never blocks the dispatch.
 */
function evalListener(
  expression: string,
  scope: Record<string, unknown>,
  input: { agentId: string; listenerId: string; log: (agentId: string, message: string, level?: 'info' | 'warn' | 'error') => void }
): boolean | undefined {
  try {
    return evaluateSafeExpression(expression, scope) === true;
  } catch (error) {
    if (error instanceof ExpressionError) {
      input.log(input.agentId, `Abort listener ${input.listenerId} failed: ${error.reason}`, 'warn');
      return undefined;
    }
    throw error;
  }
}

/**
 * Cancels every candidate run of `listener` whose `match` evaluates true;
 * appends them to `outcome.cancelled`. An expression error stops the scan
 * early (`evalListener` already logged it).
 */
function cancelMatchingRuns(
  listener: NonNullable<AgentSpecV2['abortListeners']>[number],
  input: AbortListenerInput,
  outcome: AbortOutcome
): void {
  const ctx = { agentId: input.agentId, log: input.log, listenerId: listener.id };
  for (const run of input.host.runsOf(input.agentId)) {
    if (run.triggerId !== listener.triggerId || !scopeAllows(listener.scope, run)) continue;
    const matches = evalListener(
      listener.match,
      { event: input.event, run: { event: run.event, triggerId: run.triggerId } },
      ctx
    );
    if (matches === undefined) return;
    if (!matches) continue;
    const cancelled = input.host.cancel(run.runKey, `abort_listener:${listener.id}`);
    if (cancelled === undefined) continue;
    outcome.cancelled.push({ runKey: run.runKey, status: cancelled });
    input.log(input.agentId, `Run cancelled by abort listener ${listener.id}: ${listener.when}`, 'warn');
  }
}

/**
 * Runs before dispatch for every inbound webhook/channel event of
 * `agentId`. `triggerId` names the trigger that delivered the event (the
 * run the event will itself start is not yet queued, so it can never
 * cancel itself). Returns one {@link AbortOutcome} per listener that
 * cancelled at least one run.
 */
export function applyAbortListeners(input: AbortListenerInput): AbortOutcome[] {
  const outcomes: AbortOutcome[] = [];
  for (const listener of input.spec.abortListeners ?? []) {
    const fires = evalListener(
      listener.when,
      { event: input.event },
      { agentId: input.agentId, listenerId: listener.id, log: input.log }
    );
    if (fires !== true) continue;

    const outcome: AbortOutcome = { listenerId: listener.id, cancelled: [] };
    cancelMatchingRuns(listener, input, outcome);
    if (outcome.cancelled.length > 0) outcomes.push(outcome);
  }
  return outcomes;
}
