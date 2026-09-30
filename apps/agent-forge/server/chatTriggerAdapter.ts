/**
 * ChatTriggerAdapter (LOU-T5)
 *
 * Wraps Agent Forge's existing chat transport - `RunManager.sendMessage()`
 * (see runRegistry.ts's doc comment on that method for the full
 * continuation semantics) - behind the SDK's `TriggerAdapter` shape
 * (`@loushy/build-ai-agent/triggers`), so `POST /agents/:id/message`
 * (app.ts) is registered as `'chat'` in a `TriggerRegistry` alongside the
 * webhook/cron/Slack built-ins, instead of being a bespoke, unregistered
 * code path - closing the last of the four ad hoc "ways an agent can be
 * woken up" the LOU-T5 audit called out.
 *
 * ## Conservative by design
 *
 * `trigger()` below is a pure pass-through to `RunManager.sendMessage()` -
 * it changes NOTHING about `launch()`, checkpoint/approval semantics, the
 * WS chat broadcast, or any other logic in runRegistry.ts. This is
 * deliberate: LOU-T5 requires the existing LOU-P chat test suites (49+
 * server / 74+ client tests) to keep passing UNCHANGED, so this file only
 * adds a thin adapter shell around the existing, untouched call path -
 * `app.ts`'s `POST /agents/:id/message` route below is the only thing
 * that changes, and only to call through this adapter instead of
 * `runManager.sendMessage()` directly. Every error type it can throw
 * (`AlreadyRunningError`, `ApprovalPendingError`, `AgentNotFoundError`)
 * still comes from `RunManager.sendMessage()` itself, so the route's
 * existing catch/status-code mapping needs no changes either.
 *
 * ## Why `listen()`/`reply()` aren't the real entrypoint here
 *
 * Unlike webhook/cron/Slack - each of which owns exactly one long-lived
 * listener for one agent - Agent Forge's chat already has a live,
 * per-agent-id HTTP route (`POST /agents/:id/message`) and its own reply
 * channel (the `WS /agents/:id/stream` broadcast `RunManager` already
 * drives via `emitChat()`/`handleRunSettled()`). There is no single
 * "the agent" for one `ChatTriggerAdapter` instance to `listen()` on
 * across every agent id the running server manages - `RunManager` already
 * IS that multiplexer. So `listen()` is implemented only for
 * `TriggerAdapter` interface conformance (so this can sit in a
 * `TriggerRegistry` next to the other built-ins) and throws a clear error
 * if ever actually called, rather than silently no-op-ing; `trigger()` is
 * the real, per-request entrypoint `app.ts` uses.
 */
import type { AgentSpec, ExecutionResult } from '@loushy/build-ai-agent';
import type { RunnableAgent, TriggerAdapter, TriggerContext, TriggerHandle } from '@loushy/build-ai-agent/triggers';
import type { RunManager } from './runRegistry';

export class ChatTriggerAdapter implements TriggerAdapter {
  public readonly type = 'chat';

  constructor(private readonly runManager: RunManager) {}

  /**
   * The real entrypoint - called by `POST /agents/:id/message`
   * (app.ts). Delegates straight to `RunManager.sendMessage()`, unchanged;
   * see this class's doc comment for why.
   */
  public async trigger(agentId: string, message: string, spec?: AgentSpec): Promise<void> {
    return this.runManager.sendMessage(agentId, message, spec);
  }

  /**
   * Not used by Agent Forge (see class doc comment) - present only so this
   * adapter satisfies `TriggerAdapter` and can be registered in a
   * `TriggerRegistry`. Throws rather than no-op-ing so a future caller
   * that mistakenly reaches for this path gets a clear signal to use
   * `trigger()` instead.
   */
  public listen(
    _agent: RunnableAgent,
    _onEvent: (input: string, context: TriggerContext) => Promise<ExecutionResult>
  ): TriggerHandle {
    throw new Error(
      "ChatTriggerAdapter.listen() is not used by Agent Forge - each chat message is dispatched directly via trigger(agentId, message, spec) since RunManager already multiplexes many agent ids/reply channels internally. See this file's doc comment."
    );
  }
}
