import { ConfigurationError } from '../execution/errors';
import { exampleFromTrace } from '../observe/datasets';
import { failureReportFromDb } from '../observe/failures';
import type { SqlDatabase } from '../storage/sqlite/driver';
import type { Harness, ImproveOptions, ProbeRun, RecoveryEvidence } from './types';

const DEFAULT_ADMISSION_RUNS = 6;

/** Scores an answer to a captured case: `true` or `false`, `null` when it can't be scored, or a verdict that also names the check a failed answer missed. */
export type CaseCheck = (
  input: string,
  answer: string
) =>
  | boolean
  | null
  | {
      /** Whether the answer passed. */
      passed: boolean;
      /** Which check a failed answer missed, shown to the editors as data on one line. Name the requirement, not the fix. */
      failure?: string;
    };

export function scoreCase(check: CaseCheck, input: string, answer: string): Pick<ProbeRun, 'passed' | 'failure'> {
  const result: unknown = check(input, answer);
  if (result === null || typeof result === 'boolean') return { passed: result };
  const { passed, failure } = (typeof result === 'object' ? result : {}) as { passed?: unknown; failure?: unknown };
  if (typeof passed !== 'boolean' || (failure !== undefined && typeof failure !== 'string')) {
    const got = result instanceof Promise ? 'a Promise; a CaseCheck must be synchronous' : JSON.stringify(result) ?? String(result);
    throw new ConfigurationError(`A CaseCheck must return true, false, null or { passed: boolean; failure?: string }, not ${got}.`, 'check');
  }
  return !passed && failure ? { passed, failure } : { passed };
}

/** A real run of your own agent, turned into a case for {@link improveAgent}. */
export interface CapturedCase {
  /** `<failure class>:<trace id>` for a failure, `pass:<trace id>` for a protected case. */
  id: string;
  /** The run's input, as JSON text. */
  input: string;
  /** The trace it came from. */
  traceId: string;
  /** `failure` for a case to learn from, `protected` for one that must keep passing. */
  kind: 'failure' | 'protected';
  /** From {@link casesFromRecoveries}: the `.heal` retry that passed, for `ImproveOptions.recoveries`. It never makes the case protected. */
  recovery?: RecoveryEvidence;
}

function captureCase(db: SqlDatabase, traceId: string, prefix: string, kind: CapturedCase['kind']): CapturedCase | undefined {
  const example = exampleFromTrace(db, traceId);
  if (example === 'no-trace' || example === 'no-input') return undefined;
  return { id: `${prefix}:${traceId}`, input: example.input, traceId, kind };
}

/** Turns failed runs in your local trace database into cases to learn from, at most 5 traces per failure class, skipping traces with no recorded input. */
export function casesFromFailures(
  db: SqlDatabase,
  filter: {
    since?: number;
    agent?: string;
    minScore?: number;
    /** Only these traces, such as the runs of one harness revision. */
    traceIds?: readonly string[];
    /** Only failure groups seen in two or more traces. */
    recurring?: boolean;
  } = {}
): CapturedCase[] {
  const seen = new Set<string>();
  const cases: CapturedCase[] = [];
  const { recurring, ...report } = filter;
  for (const group of failureReportFromDb(db, report).groups) {
    if (recurring && !group.recurring) continue;
    for (const traceId of group.traceIds) {
      if (seen.has(traceId)) continue;
      seen.add(traceId);
      const captured = captureCase(db, traceId, group.failureClass, 'failure');
      if (captured) cases.push(captured);
    }
  }
  return cases;
}

/** Turns runs that went well into protected cases; admit them with {@link admitProtectedCases} before they gate. */
export function protectedCasesFromPasses(db: SqlDatabase, traceIds: readonly string[]): CapturedCase[] {
  return [...new Set(traceIds)].flatMap((traceId) => captureCase(db, traceId, 'pass', 'protected') ?? []);
}

/** Builds a probe for captured cases from a function that runs your agent, scoring each answer with your check. Build each transcript with `renderTranscript`, so tool results reach the editors marked as untrusted. */
export function probeCapturedCases(
  cases: readonly CapturedCase[],
  runCase: (harness: Harness, input: string) => Promise<{ answer: string; transcript: string; tokens: number; ended: string }>,
  check: CaseCheck
): ImproveOptions['probe'] {
  const byId = new Map(cases.map((c) => [c.id, c]));
  return async (harness, caseId) => {
    const captured = byId.get(caseId);
    if (!captured) throw new ConfigurationError(`Unknown captured case "${caseId}"`, 'cases');
    const { answer, transcript, tokens, ended } = await runCase(harness, captured.input);
    return { ...scoreCase(check, captured.input, answer), transcript, tokens, ended };
  };
}

/** Runs each protected case on the current harness and keeps only those that passed every run (default 6). */
export async function admitProtectedCases(options: {
  harness: Harness;
  cases: readonly CapturedCase[];
  probe: ImproveOptions['probe'];
  runs?: number;
}): Promise<{
  /** Cases that passed every run, ready to gate. */
  admitted: CapturedCase[];
  /** Cases that missed a run, with how many runs passed and how many were scored. */
  refused: {
    /** The case's id. */
    id: string;
    /** Runs that passed. */
    passed: number;
    /** Runs that could be scored. */
    scored: number;
  }[];
}> {
  const runs = options.runs ?? DEFAULT_ADMISSION_RUNS;
  if (!Number.isInteger(runs) || runs < 1) throw new ConfigurationError(`runs must be a whole number of 1 or more, not ${runs}`, 'runs');
  const admitted: CapturedCase[] = [];
  const refused: { id: string; passed: number; scored: number }[] = [];
  for (const captured of options.cases) {
    let passed = 0;
    let scored = 0;
    for (let repeat = 0; repeat < runs; repeat++) {
      const run = await options.probe(options.harness, captured.id, repeat);
      if (run.passed !== null) scored++;
      if (run.passed === true) passed++;
    }
    if (passed === runs) admitted.push(captured);
    else refused.push({ id: captured.id, passed, scored });
  }
  return { admitted, refused };
}
