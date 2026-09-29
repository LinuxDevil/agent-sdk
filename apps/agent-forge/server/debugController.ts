/**
 * LOU-O3 step-through debugger.
 *
 * `AgentExecutor.execute()` has no native breakpoint concept - there is no
 * per-node hook, and the loop inside `runAgentLoop()` is private. What it
 * DOES expose (see `ExecuteOptions` in src/execution/AgentExecutor.ts) is a
 * set of lifecycle callbacks invoked synchronously around the two things a
 * step in this app's fixed trigger->llm->tool(s)->approval->output pipeline
 * actually corresponds to: `onLLMRequest`/`onLLMResponse` (before/after each
 * provider.generate() call - the "llm" node) and `onToolCall`/`onToolResult`
 * (before/after each tool execution - a "tool" node). All four are allowed
 * to return a `Promise` that `execute()` awaits before continuing.
 *
 * That is the real, honest control surface this class uses: a "breakpoint"
 * is a `{phase, boundary}` key matched against one of these four hook call
 * sites, and "pausing" is `await`-ing a promise inside the hook that only
 * resolves when the client calls continue()/step(). This is genuinely a
 * pause of the live execution (the awaited generate()/tool call has not
 * been made yet, or its result has not yet been folded back into the
 * conversation) - NOT a synthetic/simulated pause layered on top of
 * already-complete work.
 *
 * What this can'T do, honestly: there is no breakpoint *inside* a single
 * provider.generate() call or *inside* a single tool's execute() body (the
 * SDK doesn't instrument that deep), and a "trigger" or "output" node has no
 * corresponding hook at all (the pipeline's trigger is just the initial
 * `input`, and "output" is just the final `ExecutionResult` - neither is a
 * discrete step the executor invokes a callback around). So breakpoints are
 * only supported on `llm` and `tool` nodes, matching this app's graph model
 * (graph/types.ts) - see the epic report for the full breakdown.
 */
import type { GenerateOptions, Message, ToolCall } from '@loushy/build-ai-agent';

export type DebugBoundary = 'before' | 'after';

/** `'llm:before'`, `'llm:after'`, `` `tool:${toolName}:before` ``, `` `tool:${toolName}:after` ``. */
export type BreakpointKey = string;

export function llmBreakpointKey(boundary: DebugBoundary): BreakpointKey {
  return `llm:${boundary}`;
}

export function toolBreakpointKey(toolName: string, boundary: DebugBoundary): BreakpointKey {
  return `tool:${toolName}:${boundary}`;
}

export interface DebugStateSnapshot {
  paused: boolean;
  atBreakpoint?: { phase: string; boundary: DebugBoundary };
  /** The live message array as of the last hook call - only meaningful while paused. */
  messages: Message[];
  /** Number of completed LLM generate() calls so far (a proxy for AgentExecutor's internal step counter). */
  stepCount: number;
  breakpoints: BreakpointKey[];
}

export type DebugHooks = Pick<
  import('@loushy/build-ai-agent').ExecuteOptions,
  'onLLMRequest' | 'onLLMResponse' | 'onToolCall' | 'onToolResult'
>;

/**
 * One debug session per live run. Breakpoints can be updated mid-run (the
 * hooks re-read `this.breakpoints` on every call), so setting a breakpoint
 * while a run is already in flight takes effect on its very next hook call.
 */
export class DebugSession {
  private breakpoints: Set<BreakpointKey>;
  private paused = false;
  private stepRequested = false;
  private resumeResolve?: () => void;
  private lastMessages: Message[] = [];
  private stepCount = 0;
  private current: { phase: string; boundary: DebugBoundary } | undefined;

  constructor(
    initialBreakpoints: Iterable<BreakpointKey>,
    private readonly onChange: (state: DebugStateSnapshot) => void
  ) {
    this.breakpoints = new Set(initialBreakpoints);
  }

  setBreakpoints(keys: Iterable<BreakpointKey>): void {
    this.breakpoints = new Set(keys);
    this.onChange(this.snapshot());
  }

  /** Resumes a paused run without changing the breakpoint set. No-op if not paused. */
  continue(): void {
    this.release();
  }

  /**
   * Resumes a paused run (or, if not currently paused, arms a one-shot
   * pause at the very next hook boundary regardless of the breakpoint set)
   * - real single-step execution bounded by the granularity above (one LLM
   * call or one tool call at a time, not a single line of agent logic).
   */
  step(): void {
    if (this.paused) {
      this.stepRequested = true;
      this.release();
    } else {
      this.stepRequested = true;
    }
  }

  snapshot(): DebugStateSnapshot {
    return {
      paused: this.paused,
      atBreakpoint: this.current,
      messages: this.lastMessages,
      stepCount: this.stepCount,
      breakpoints: [...this.breakpoints],
    };
  }

  hooks(): DebugHooks {
    return {
      onLLMRequest: async (request: GenerateOptions) => {
        this.lastMessages = request.messages;
        await this.maybePause('llm', 'before');
      },
      onLLMResponse: async () => {
        this.stepCount += 1;
        await this.maybePause('llm', 'after');
      },
      onToolCall: async (toolCall: ToolCall) => {
        await this.maybePause(toolCall.function.name, 'before');
      },
      onToolResult: async (toolCall: ToolCall) => {
        await this.maybePause(toolCall.function.name, 'after');
      },
    };
  }

  private release(): void {
    const resolve = this.resumeResolve;
    this.resumeResolve = undefined;
    resolve?.();
  }

  private async maybePause(phase: string, boundary: DebugBoundary): Promise<void> {
    const key = phase === 'llm' ? llmBreakpointKey(boundary) : toolBreakpointKey(phase, boundary);
    if (!this.breakpoints.has(key) && !this.stepRequested) return;
    this.stepRequested = false;
    this.paused = true;
    this.current = { phase, boundary };
    // `resumeResolve` must be assigned BEFORE `onChange()` fires - onChange
    // synchronously notifies subscribers (see runRegistry.ts's
    // makeDebugSession), and a subscriber is allowed to call continue()/
    // step() synchronously in response (e.g. a test, or a client that
    // auto-continues past a particular breakpoint). If the Promise executor
    // ran after onChange(), that synchronous continue() would silently
    // no-op against an as-yet-unset resumeResolve and the pause would never
    // release.
    const pause = new Promise<void>((resolve) => {
      this.resumeResolve = resolve;
    });
    this.onChange(this.snapshot());
    await pause;
    this.paused = false;
    this.current = undefined;
    this.onChange(this.snapshot());
  }
}
