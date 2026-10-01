/**
 * Cancellation support for `POST /agents/:id/stop`.
 *
 * `AgentExecutor.execute()` (src/execution/AgentExecutor.ts, read in full
 * for this ticket) is a static, instance-free async call with NO
 * cancellation-token option in `ExecuteOptions` at all - no `signal`, no
 * `abortSignal`, nothing. Its internal `while (steps < maxSteps)` loop has
 * exactly one await point per step that can take real wall-clock time:
 * `provider.generate(generateRequest)`. Everything else in a step (pushing
 * to arrays, JSON.stringify, checkpoint writes) is effectively synchronous.
 *
 * So rather than inventing an API AgentExecutor doesn't have, cancellation
 * here is implemented the way the ticket's fallback describes: "kill the
 * in-flight provider call". This wraps whatever LLMProvider the run was
 * built with with one that checks an AbortSignal immediately before
 * calling through to the real `generate()`/`stream()`, and throws an
 * AbortError instead of calling through if the signal is already aborted.
 *
 * Effect: `stop()` (runRegistry.ts) aborts the controller; the NEXT
 * provider call this wrapper makes (at the very next step boundary, or
 * immediately if a call is currently pending model-side and the underlying
 * provider is itself abort-aware) throws, which propagates out of
 * AgentExecutor.execute()'s catch block (it only emits an 'error' event and
 * rethrows - it does not swallow) as a rejected promise. Crucially,
 * AgentExecutor only clears the CheckpointStore entry on a *successful*
 * terminal completion (see the bottom of runAgentLoop(), reached only after
 * the while-loop `break`s) - never from the catch block - so an abort
 * leaves the last-saved checkpoint (written after each completed tool
 * result) intact. The next `run()` call for the same agent reuses the same
 * sessionId, so AgentExecutor.execute() rehydrates from exactly that
 * checkpoint instead of starting over. This is what makes Stop-then-Run
 * "resume from the last checkpoint" rather than "restart from scratch".
 *
 * Caveat (documented, not fixed here - real-provider wiring is LOU-R's
 * job): for the MockLLMProvider used by default in this epic, `generate()`
 * has no real network I/O to cancel, so this wrapper's pre-call check is
 * the entire cancellation mechanism - a mock call already in flight when
 * `stop()` fires will still resolve, but the loop will not continue to a
 * further step. A real provider wired up later should thread the same
 * AbortSignal into its underlying fetch/SDK call for true mid-request
 * cancellation; this wrapper's shape (signal checked, forwarded if the
 * real provider accepts one) is what that wiring would build on.
 */
import type { LLMProvider, GenerateOptions, GenerateResult, StreamResult } from '@loushy/build-ai-agent';

/**
 * Named `AbortError` (the fetch/AbortSignal convention) on purpose: the SDK's
 * AgentExecutor rethrows an `AbortError` from provider.generate() untouched
 * (see `isAbortError()` in src/execution/errors.ts) instead of compacting it
 * into a `CompactedLLMProviderError`, which is what lets runRegistry.ts's
 * `instanceof RunAbortedError` check recognise a user-initiated stop().
 */
export class RunAbortedError extends Error {
  constructor() {
    super('Run was stopped');
    this.name = 'AbortError';
  }
}

export function withAbortSignal(provider: LLMProvider, signal: AbortSignal): LLMProvider {
  function checkAborted(): void {
    if (signal.aborted) throw new RunAbortedError();
  }

  return {
    name: provider.name,
    async generate(options: GenerateOptions): Promise<GenerateResult> {
      checkAborted();
      const result = await provider.generate(options);
      checkAborted();
      return result;
    },
    async stream(options: GenerateOptions): Promise<StreamResult> {
      checkAborted();
      return provider.stream(options);
    },
    supportsTools(model: string): boolean {
      return provider.supportsTools(model);
    },
    supportsStreaming(model: string): boolean {
      return provider.supportsStreaming(model);
    },
    async getModels(): Promise<string[]> {
      return provider.getModels();
    },
  };
}
