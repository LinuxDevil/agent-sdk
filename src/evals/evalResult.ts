/**
 * Structured eval results (LOU-D7).
 *
 * Every eval case - the classic `score`/`threshold` form and the trajectory
 * `test(t)` form - produces one `EvalResult`. `loushy eval` collects them to
 * print a summary and write JUnit/JSON reports.
 */

/** How an assertion counts: a `gate` fails the eval, a `soft` one is only reported. */
export type AssertionKind = 'gate' | 'soft';

/** One assertion made while an eval case ran. */
export interface AssertionResult {
  /** Name shown in reports, e.g. `calledTool('lookup_order')` or `tone`. */
  name: string;
  kind: AssertionKind;
  passed: boolean;
  /** 1 or 0 for yes/no assertions, the measured value for scored ones (judge, atLeast). */
  score: number;
  /** Minimum score for the assertion to pass, when it has one. */
  threshold?: number;
  /** Diagnostic detail; always present when `passed` is false. */
  message?: string;
  /** True when the assertion could not be evaluated (for example no cost data) and counted as passed. */
  skipped?: boolean;
}

/** A tool call the agent made, with parsed arguments. */
export interface EvalToolCall {
  name: string;
  args: unknown;
}

/** The outcome of one eval case. */
export interface EvalResult {
  /** The `name` given to `defineEval()`. */
  name: string;
  /** Label of the dataset case; absent for an eval without `cases`. */
  case?: string;
  tags: string[];
  /** False when any gate assertion failed or the case threw. */
  passed: boolean;
  assertions: AssertionResult[];
  durationMs: number;
  /** Model steps across every `t.send()` of the case. */
  steps: number;
  toolCalls: EvalToolCall[];
  /** Token usage summed over the case's runs, when any run reported it. */
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  /** Set when the case threw (a failed `send()`, an unconfigured `judge()`, ...). */
  error?: string;
  /** Test file the eval was defined in, when known. */
  file?: string;
}

/** Gate assertions that failed. */
export function gateFailures(result: EvalResult): AssertionResult[] {
  return result.assertions.filter((a) => a.kind === 'gate' && !a.passed);
}

/** Soft assertions that failed. */
export function softFailures(result: EvalResult): AssertionResult[] {
  return result.assertions.filter((a) => a.kind === 'soft' && !a.passed);
}

/** Builds the one-assertion result of a classic `score`/`threshold` eval. */
export function scoreAssertion(score: number, threshold: number): AssertionResult {
  const passed = score >= threshold;
  return {
    name: 'score',
    kind: 'gate',
    passed,
    score,
    threshold,
    message: passed ? undefined : `score ${score} is below the threshold ${threshold}`,
  };
}
