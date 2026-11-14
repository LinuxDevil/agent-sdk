/**
 * gateRunner: `runEvalGates(spec, deps)` - the publish gate's engine (X01a).
 * Every `EvalGateSpec` in `spec.evals` runs its observe dataset's examples
 * through the candidate spec, one at a time and sequentially across sets
 * (keeps cost predictable), and answers an {@link EvalGateResult} saying
 * per dataset which examples passed, why the others failed, and whether
 * the pass rate met `minPassRate`.
 *
 * Nothing calls this from a route yet - X01b wires it into
 * `POST /agents/:id/publish`. It is exported for its test and for X01b.
 *
 * Failure semantics (the ticket's contract):
 * - A dataset that is missing, empty or unreachable fails its whole set
 *   (`error` set, `examples: []`, `passed: false`).
 * - A run that throws or ends `finishReason: 'error'`/`'aborted'` fails its
 *   example with `Run failed: <error>` and skips the example's other gates.
 * - The `judge` gate is a PassRunner `eval_judge` job; a judge that cannot
 *   answer fails the example - a gate that could not be checked never
 *   passes.
 */
import type { AgentSpecV2, EvalGate, EvalGateSpec } from 'lousho/spec';
import type { EvalExampleResult, EvalGateResult, EvalGateSetResult } from '../../shared/wireTypes';
import type { PassRunner } from '../passes/passRunner';
import type { SecretsStore } from '../secretsStore';
import type { SettingsStore } from '../settingsStore';
import { runCandidate, EVAL_EXAMPLE_TIMEOUT_MS } from './candidateRun';
import { fetchDatasetExamples, EVAL_MAX_EXAMPLES, type DatasetExample } from './datasetClient';
import { DETERMINISTIC_CHECKS } from './gateChecks';
import { judgeExample } from './judgeGate';
import type { CandidateRun } from './types';

export { EVAL_MAX_EXAMPLES } from './datasetClient';
export { EVAL_EXAMPLE_TIMEOUT_MS } from './candidateRun';
export type { CandidateRun } from './types';

/** Runs one input on the candidate spec (tests inject a fake). */
export type RunExampleFn = (spec: AgentSpecV2, input: string, signal: AbortSignal) => Promise<CandidateRun>;

export interface EvalGateDeps {
  agentId: string;
  baseDir: string;
  secretsStore: SecretsStore;
  settings: SettingsStore;
  passRunner: PassRunner;
  /** Default `runCandidate`. */
  runExample?: RunExampleFn;
  /** The fetch dataset calls go through (tests). */
  fetch?: typeof fetch;
  /** The clock `ranAt` reads (tests). */
  now?: () => number;
}

/** `n / total` rounded to 4 decimals (the contract's `passRate` precision). */
function passRateOf(passed: number, total: number): number {
  return Math.round((passed / total) * 10_000) / 10_000;
}

/** A gate's single spec key (`calledTool`, `judge`, ...) - the union is single-key by schema. */
function gateKey(gate: EvalGate): string {
  return Object.keys(gate)[0];
}

/**
 * One example's abort signal, capped at {@link EVAL_EXAMPLE_TIMEOUT_MS} by a
 * real `setTimeout` (not `AbortSignal.timeout`, which fake timers cannot
 * reach - tests advance the cap with `vi.advanceTimersByTime`).
 */
function exampleSignal(): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException(`timed out after ${EVAL_EXAMPLE_TIMEOUT_MS} ms`, 'TimeoutError')),
    EVAL_EXAMPLE_TIMEOUT_MS
  );
  timer.unref();
  return { signal: controller.signal, cancel: () => clearTimeout(timer) };
}

/** The example's `CandidateRun`, or a failed one when `runExample` itself threw. */
async function safeRun(
  runExample: RunExampleFn,
  spec: AgentSpecV2,
  input: string
): Promise<CandidateRun> {
  const { signal, cancel } = exampleSignal();
  try {
    return await runExample(spec, input, signal);
  } catch (error) {
    return {
      text: '',
      toolNames: [],
      costUsd: null,
      steps: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    cancel();
  }
}

/** The failure sentences of one example's non-judge gates, in spec order. */
function deterministicFailures(gates: readonly EvalGate[], run: CandidateRun): string[] {
  const failures: string[] = [];
  for (const gate of gates) {
    if (gateKey(gate) === 'judge') continue;
    const check = DETERMINISTIC_CHECKS[gateKey(gate)];
    const failure = check?.(gate as never, run);
    if (failure !== null && failure !== undefined) failures.push(failure);
  }
  return failures;
}

/** The failure sentences of one example's judge gates, in spec order. */
async function judgeFailures(
  gates: readonly EvalGate[],
  example: DatasetExample,
  run: CandidateRun,
  deps: EvalGateDeps
): Promise<string[]> {
  const failures: string[] = [];
  for (const gate of gates) {
    if (!('judge' in gate)) continue;
    const failure = await judgeExample(gate.judge, example, run, {
      agentId: deps.agentId,
      passRunner: deps.passRunner,
      secretsStore: deps.secretsStore,
      settings: deps.settings,
    });
    if (failure !== null) failures.push(failure);
  }
  return failures;
}

/** One example's gates: deterministic first, then the judge check(s). */
async function exampleFailures(
  spec: EvalGateSpec,
  example: DatasetExample,
  run: CandidateRun,
  deps: EvalGateDeps
): Promise<string[]> {
  const deterministic = deterministicFailures(spec.gates, run);
  const judged = await judgeFailures(spec.gates, example, run, deps);
  return [...deterministic, ...judged];
}

/** One example end to end: run it, then check its gates (a failed run skips them). */
async function runOneExample(
  spec: AgentSpecV2,
  gate: EvalGateSpec,
  example: DatasetExample,
  deps: EvalGateDeps,
  runExample: RunExampleFn
): Promise<EvalExampleResult> {
  const run = await safeRun(runExample, spec, example.input);
  const base = {
    exampleId: example.exampleId,
    ...(run.traceId !== undefined && { traceId: run.traceId }),
  };
  if (run.error !== undefined) {
    return { ...base, passed: false, failures: [`Run failed: ${run.error}`] };
  }
  const failures = await exampleFailures(gate, example, run, deps);
  return { ...base, passed: failures.length === 0, failures };
}

/** A set that could not run at all: `error` set, no examples, `passed` false. */
function failedSet(gate: EvalGateSpec, error: string): EvalGateSetResult {
  return { dataset: gate.dataset, passRate: 0, minPassRate: gate.minPassRate, passed: false, examples: [], error };
}

/** One `spec.evals` entry: fetch its dataset, run every example, score the pass rate. */
async function runGateSet(
  spec: AgentSpecV2,
  gate: EvalGateSpec,
  deps: EvalGateDeps,
  runExample: RunExampleFn
): Promise<EvalGateSetResult> {
  const fetched = await fetchDatasetExamples(gate.dataset, { fetch: deps.fetch, limit: EVAL_MAX_EXAMPLES });
  if (!fetched.ok) return failedSet(gate, fetched.error);
  if (fetched.examples.length === 0) return failedSet(gate, `Dataset '${gate.dataset}' has no examples`);
  const examples: EvalExampleResult[] = [];
  for (const example of fetched.examples) {
    examples.push(await runOneExample(spec, gate, example, deps, runExample));
  }
  const passed = examples.filter((entry) => entry.passed).length;
  const passRate = passRateOf(passed, examples.length);
  return {
    dataset: gate.dataset,
    passRate,
    minPassRate: gate.minPassRate,
    passed: passRate >= gate.minPassRate && examples.length > 0,
    examples,
  };
}

/**
 * Runs every `EvalGateSpec` in `spec.evals` (in order, examples sequential)
 * and returns the combined {@link EvalGateResult}; `passed` is every set
 * passed. A spec with no `evals` returns `{ passed: true, gates: [], ranAt }`.
 */
export async function runEvalGates(spec: AgentSpecV2, deps: EvalGateDeps): Promise<EvalGateResult> {
  const runExample: RunExampleFn =
    deps.runExample ?? ((candidate, input, signal) => runCandidate(candidate, input, signal, deps));
  const gates: EvalGateSetResult[] = [];
  for (const gate of spec.evals ?? []) {
    gates.push(await runGateSet(spec, gate, deps, runExample));
  }
  return {
    passed: gates.every((gate) => gate.passed),
    gates,
    ranAt: new Date((deps.now ?? Date.now)()).toISOString(),
  };
}
