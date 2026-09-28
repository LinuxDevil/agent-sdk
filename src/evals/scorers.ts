/**
 * Scorers for defineEval() (LOU-G3/G4/G5)
 *
 * All scorer factories return a plain, synchronous `(result: ExecutionResult) => number`
 * function - the same shape defineEval()'s `score` field expects. None of
 * them throw on a non-match/mismatch; they simply return 0.
 */

import { ExecutionResult } from '../execution/AgentExecutor';
import { ToolCall } from '../providers/llm';

// ---------------------------------------------------------------------------
// LOU-G3: rule-based / exact-match scorer
// ---------------------------------------------------------------------------

/**
 * A matcher against the ExecutionResult's `.text` field: exact string
 * equality, a RegExp tested against the text, or a predicate function.
 */
export type Matcher = string | RegExp | ((text: string) => boolean);

/**
 * Returns a scorer that checks `result.text` against `matcher`:
 *  - string: exact equality
 *  - RegExp: `.test(text)`
 *  - function: called with `text`, its boolean return is used
 *
 * Never throws for a non-match - always resolves to 1 (match) or 0
 * (no match).
 */
export function exactMatch(matcher: Matcher): (result: ExecutionResult) => number {
  return (result: ExecutionResult): number => {
    const text = result.text ?? '';

    try {
      if (typeof matcher === 'string') {
        return text === matcher ? 1 : 0;
      }
      if (matcher instanceof RegExp) {
        return matcher.test(text) ? 1 : 0;
      }
      return matcher(text) ? 1 : 0;
    } catch {
      // A throwing predicate is treated as a non-match, not a scorer crash.
      return 0;
    }
  };
}

// ---------------------------------------------------------------------------
// LOU-G4: tool-call-order assertion scorer
// ---------------------------------------------------------------------------

/**
 * A single expected tool call in an expected sequence. `args`, when given,
 * is compared to the actual parsed call arguments via JSON.stringify
 * equality.
 */
export interface ExpectedCall {
  tool: string;
  args?: Record<string, unknown>;
}

/**
 * How tool calls actually reach the scorer: AgentExecutor.execute()'s real
 * ExecutionResult (src/execution/AgentExecutor.ts) already carries a
 * top-level `toolCalls: ToolCall[]` field. It's populated as the run's
 * loop accumulates every tool call the model made
 * (`allToolCalls.push(...result.toolCalls)` in runAgentLoop()), across
 * every step, in request order. There is no need to collect calls via the
 * LOU-E onToolCall/onToolResult tracing hooks for this - the plain field
 * on the result already exposes the full, ordered call list. Each entry's
 * `function.arguments` is a JSON string (the raw provider tool-call
 * arguments), so args comparison below JSON.parses it before comparing.
 */
export function toolCallOrder(expected: ExpectedCall[]): (result: ExecutionResult) => number {
  return (result: ExecutionResult): number => {
    const actual: ToolCall[] = result.toolCalls ?? [];

    if (actual.length !== expected.length) {
      return 0;
    }

    for (let i = 0; i < expected.length; i++) {
      const expectedCall = expected[i];
      const actualCall = actual[i];

      if (actualCall.function.name !== expectedCall.tool) {
        return 0;
      }

      if (expectedCall.args !== undefined) {
        let actualArgs: unknown;
        try {
          actualArgs = JSON.parse(actualCall.function.arguments);
        } catch {
          return 0;
        }

        if (JSON.stringify(actualArgs) !== JSON.stringify(expectedCall.args)) {
          return 0;
        }
      }
    }

    return 1;
  };
}

// ---------------------------------------------------------------------------
// LOU-G5: token/step budget scorer
// ---------------------------------------------------------------------------

export interface Budget {
  maxTokens?: number;
  maxSteps?: number;
}

/**
 * Returns a scorer that checks `result.usage.totalTokens` and `result.steps`
 * (the real field names on ExecutionResult) against `limits`. Returns 0 if
 * either configured limit is exceeded, 1 otherwise. A limit left
 * `undefined` is not checked.
 */
export function budget(limits: Budget): (result: ExecutionResult) => number {
  return (result: ExecutionResult): number => {
    if (limits.maxTokens !== undefined && result.usage.totalTokens > limits.maxTokens) {
      return 0;
    }
    if (limits.maxSteps !== undefined && result.steps > limits.maxSteps) {
      return 0;
    }
    return 1;
  };
}

/**
 * Produces a human-readable description of which budget(s) a result
 * exceeded, e.g. "tokens 1500 exceeded maxTokens 1000 by 500". Checks both
 * tokens and steps, and includes a clause for each that failed.
 */
export function describeBudgetFailure(result: ExecutionResult, limits: Budget): string {
  const failures: string[] = [];

  if (limits.maxTokens !== undefined && result.usage.totalTokens > limits.maxTokens) {
    const over = result.usage.totalTokens - limits.maxTokens;
    failures.push(
      `tokens ${result.usage.totalTokens} exceeded maxTokens ${limits.maxTokens} by ${over}`
    );
  }

  if (limits.maxSteps !== undefined && result.steps > limits.maxSteps) {
    const over = result.steps - limits.maxSteps;
    failures.push(`steps ${result.steps} exceeded maxSteps ${limits.maxSteps} by ${over}`);
  }

  if (failures.length === 0) {
    return 'no budget exceeded';
  }

  return failures.join('; ');
}
