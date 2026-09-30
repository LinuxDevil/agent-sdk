/**
 * Trigger adapters (LOU-T5).
 *
 * A TriggerAdapter is the inverse of a DeploymentAdapter
 * (src/deploy/types.ts): where a DeploymentAdapter turns an agent config
 * into a deployable artifact for one HOSTING target (node-server,
 * cloudflare-worker, docker, ...), a TriggerAdapter turns one WAKE-UP
 * mechanism (an inbound webhook, a cron schedule, a Slack message, a chat
 * message) into an agent run. Modeled after that same
 * `{type, ...lifecycle methods}` shape - see DeploymentAdapter's doc
 * comment for the pattern this mirrors.
 *
 * This is the SDK's answer to Factor 11 ("Trigger from anywhere, meet
 * users where they are") from the 12-factor-agents audit: before this,
 * every trigger integration (examples/slack-notifier, AgentSpec's
 * `triggers` field, Agent Forge's chat route) was ad hoc, with no shared
 * registry or interface - the equivalent of ToolRegistry existing for
 * tools but not for triggers.
 *
 * ## Why `listen()` takes BOTH `agent` and `onEvent`
 *
 * `agent` is the plain "prompt in, text out" surface (see `RunnableAgent`
 * below - structurally the same shape createAgent() returns). `onEvent` is
 * the actual execution entrypoint the adapter calls when its trigger
 * fires. They are deliberately separate:
 *
 * - A simple adapter (or a simple caller) can wire `onEvent` as literally
 *   `(input) => agent.send(input)` and get "trigger fires -> agent runs"
 *   with no extra plumbing.
 * - A caller with more machinery around execution - checkpointing,
 *   approval gates, hooks, sandboxing, abort control (exactly what Agent
 *   Forge's RunManager.launch() does around AgentExecutor.execute(), see
 *   apps/agent-forge/server/runRegistry.ts) - supplies an `onEvent` that
 *   wraps all of that instead, while `agent` remains available to the
 *   adapter for cases where it has nothing more specific to call (e.g. a
 *   caller that just wants the default behavior).
 *
 * This is what lets ONE interface fit all three trigger shapes even
 * though their reply semantics differ:
 *
 * - **Webhook**: HTTP request in -> `onEvent(body, {request})` -> the
 *   `ExecutionResult` it resolves to is written straight back as the HTTP
 *   response. No separate `reply()` needed - the "reply channel" IS the
 *   still-open HTTP response, captured in `context`.
 * - **Cron**: timer fires -> `onEvent(scheduledInput, {firedAt})` -> there
 *   is no caller waiting for a response, so the result is handed to an
 *   `onResult` sink supplied to the adapter's constructor instead. `reply`
 *   is intentionally left undefined on this adapter.
 * - **Slack**: message event in -> `onEvent(text, {channel})` -> the
 *   `ExecutionResult`'s text is posted back to `channel` via `reply()`,
 *   which posts asynchronously over Slack's HTTP API/webhook - a genuinely
 *   separate channel from however the event arrived.
 * - **Chat** (Agent Forge): mirrors Slack's shape - the "channel" is a
 *   running agent's WS stream, `reply()` (indirectly, via the existing
 *   RunManager broadcast plumbing) pushes chat events over it.
 *
 * `TriggerHandle.stop()` is the one piece of lifecycle every adapter
 * needs regardless of reply semantics: a webhook needs its HTTP listener
 * torn down, a cron needs its timer cleared, Slack/chat need their
 * event subscriptions closed. DeploymentAdapter has no start/stop
 * equivalent (its lifecycle is scaffold -> build -> describe, all
 * build-time, nothing left running afterwards) - `TriggerHandle` exists
 * precisely because trigger adapters, unlike deployment adapters, keep
 * something running until explicitly stopped.
 */
import type { ExecutionResult } from '../execution/AgentExecutor';

/**
 * The minimal "prompt in, text/result out" surface a trigger adapter needs
 * from an agent. Structurally identical to `SimpleAgent`
 * (src/createAgent.ts) - kept as its own, decoupled interface here (rather
 * than importing SimpleAgent) so `src/triggers` doesn't take a hard
 * dependency on `src/createAgent`'s module for what is, on purpose, just a
 * shape.
 */
export interface RunnableAgent {
  send(message: string): Promise<ExecutionResult>;
}

/** Extra, trigger-specific data passed alongside the raw input to `onEvent`. */
export interface TriggerContext {
  /**
   * Opaque reply target for this event (an HTTP `res`, a Slack channel id,
   * a chat session id, ...). Adapters that implement `reply()` document
   * the concrete type they expect here.
   */
  channel?: unknown;
  /** Additional adapter-specific fields (headers, timestamps, message ids, ...). */
  [key: string]: unknown;
}

/** Returned by `listen()`; the one thing every trigger adapter can do regardless of reply semantics. */
export interface TriggerHandle {
  /** Stops listening for new trigger events (closes the HTTP listener, clears the timer, unsubscribes, ...). */
  stop(): Promise<void> | void;
}

/**
 * A single way an agent can be woken up. See the module doc comment above
 * for the full design rationale.
 */
export interface TriggerAdapter<TChannel = unknown> {
  /** Adapter kind, e.g. 'webhook' | 'cron' | 'slack' | 'chat'. Used as the TriggerRegistry key. */
  type: string;
  /**
   * Starts listening for this adapter's trigger events. Each time one
   * fires, the adapter calls `onEvent(input, context)` and - for adapters
   * that have a reply channel - uses the resolved `ExecutionResult` to
   * reply (via `reply()` or, for webhook, by writing the HTTP response
   * directly).
   */
  listen(
    agent: RunnableAgent,
    onEvent: (input: string, context: TriggerContext) => Promise<ExecutionResult>
  ): TriggerHandle;
  /**
   * Optional: posts `message` back to `channel`. Present on adapters with
   * an out-of-band reply channel (Slack, chat); intentionally absent on
   * adapters where the reply IS the open request (webhook) or where there
   * is no reply target at all (cron).
   */
  reply?(channel: TChannel, message: string): Promise<void>;
}
