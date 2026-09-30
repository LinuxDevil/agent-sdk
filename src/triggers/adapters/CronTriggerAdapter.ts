/**
 * Cron trigger adapter (LOU-T5).
 *
 * Fires an agent run on a fixed interval rather than in response to an
 * inbound request. Deliberately scheduled by a plain millisecond interval
 * (`intervalMs`) rather than parsing real cron syntax ('* * * * *') - this
 * SDK has no existing cron-expression dependency, and adding one (plus a
 * scheduler loop, timezone handling, etc.) is out of scope for landing the
 * TriggerAdapter interface itself. `intervalMs` covers the same "run
 * periodically" need; a `CronExpressionTriggerAdapter` that layers real
 * cron syntax on top of this same interface is a natural, separately
 * scoped follow-up.
 *
 * Reply semantics: there is no caller waiting on a response the way an
 * HTTP request or a Slack message is - so results are handed to the
 * `onResult` sink supplied at construction time instead of a `reply()`
 * method (which is intentionally left undefined here; see types.ts's doc
 * comment).
 */
import type { ExecutionResult } from '../../execution/AgentExecutor';
import { RunnableAgent, TriggerAdapter, TriggerContext, TriggerHandle } from '../types';

export interface CronTriggerAdapterOptions {
  /** How often to fire, in milliseconds. Must be a positive integer. */
  intervalMs: number;
  /** The input to run the agent with on each tick. */
  input: string;
  /** Called with the outcome of each scheduled run (success or failure). */
  onResult: (result: ExecutionResult | undefined, error: unknown, context: TriggerContext) => void;
  /** If true, fires once immediately in addition to the interval. Defaults to false. */
  fireImmediately?: boolean;
}

export class CronTriggerAdapter implements TriggerAdapter {
  public readonly type = 'cron';

  constructor(private readonly options: CronTriggerAdapterOptions) {
    if (!Number.isFinite(options.intervalMs) || options.intervalMs <= 0) {
      throw new Error('CronTriggerAdapter: options.intervalMs must be a positive number');
    }
  }

  public listen(
    agent: RunnableAgent,
    onEvent: (input: string, context: TriggerContext) => Promise<ExecutionResult>
  ): TriggerHandle {
    void agent;
    let tickCount = 0;

    const fire = () => {
      const context: TriggerContext = { firedAt: new Date().toISOString(), tick: tickCount++ };
      onEvent(this.options.input, context)
        .then((result) => this.options.onResult(result, undefined, context))
        .catch((error: unknown) => this.options.onResult(undefined, error, context));
    };

    if (this.options.fireImmediately) {
      fire();
    }
    const timer = setInterval(fire, this.options.intervalMs);
    // Don't keep the process alive solely because a cron trigger is
    // listening (mirrors how e.g. Node's own http/net timers behave when
    // `.unref()`-ed); a caller that wants to keep the process alive should
    // hold its own reference/handle open.
    if (typeof timer.unref === 'function') {
      timer.unref();
    }

    return {
      stop: () => {
        clearInterval(timer);
      },
    };
  }
}
