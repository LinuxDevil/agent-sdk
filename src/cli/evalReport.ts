/**
 * Pure aggregation and rendering for `lousho eval` (LOU-D8): the summary
 * table, JUnit XML and JSON. No I/O, so every output is snapshot-testable.
 */
import {
  gateFailures,
  softFailures,
  type AssertionResult,
  type EvalResult,
} from '../evals/evalResult';
import type { DriftEntry } from '../evals/drift';
import * as path from 'node:path';

/** Totals over a run of evals. */
export interface EvalSummary {
  total: number;
  /** Cases whose gates all passed (and, with `strict`, whose soft assertions did too). */
  passed: number;
  /** Cases that failed a gate, threw, or (with `strict`) failed a soft assertion. */
  failed: number;
  /** Cases that passed their gates but have failed soft assertions. */
  softFailed: number;
  strict: boolean;
  durationMs: number;
}

/** Parses the JSON-lines results file; malformed lines are skipped. */
export function parseResults(text: string): EvalResult[] {
  const results: EvalResult[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      results.push(JSON.parse(line) as EvalResult);
    } catch {
      // A line cut off by a crashed worker; the vitest exit code still reports the crash.
    }
  }
  return results;
}

/** True when `result` fails the run: a gate failure or error, or a soft failure under `strict`. */
export function failsRun(result: EvalResult, strict: boolean): boolean {
  return !result.passed || (strict && softFailures(result).length > 0);
}

/** Totals for `results`. */
export function summarize(results: readonly EvalResult[], strict: boolean): EvalSummary {
  const failed = results.filter((r) => failsRun(r, strict)).length;
  return {
    total: results.length,
    passed: results.length - failed,
    failed,
    softFailed: results.filter((r) => r.passed && softFailures(r).length > 0).length,
    strict,
    durationMs: results.reduce((sum, r) => sum + r.durationMs, 0),
  };
}

function formatScore(assertion: AssertionResult): string {
  const score = Number.isInteger(assertion.score) ? String(assertion.score) : assertion.score.toFixed(2);
  return `${assertion.name}=${score}`;
}

/** Scored assertions (anything that is not a plain yes/no gate) for the table's SCORES column. */
function scoresColumn(result: EvalResult): string {
  const scored = result.assertions.filter((a) => a.kind === 'soft' || !Number.isInteger(a.score) || a.name === 'score');
  return scored.map(formatScore).join(', ') || '-';
}

function resultColumn(result: EvalResult, strict: boolean): string {
  if (failsRun(result, strict)) return 'FAIL';
  return softFailures(result).length > 0 ? 'PASS (soft fail)' : 'PASS';
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`;
}

function renderRows(rows: string[][]): string[] {
  const widths = rows[0].map((_, col) => Math.max(...rows.map((row) => row[col].length)));
  return rows.map((row) => row.map((cell, col) => cell.padEnd(widths[col])).join('  ').trimEnd());
}

function failureLines(title: string, results: readonly EvalResult[], pick: (r: EvalResult) => string[]): string[] {
  const entries = results.flatMap((r) => pick(r).map((message) => `  ${label(r)}: ${message}`));
  return entries.length === 0 ? [] : ['', `${title}:`, ...entries];
}

function label(result: EvalResult): string {
  return result.case ? `${result.name} [${result.case}]` : result.name;
}

function gateMessages(result: EvalResult): string[] {
  const messages = gateFailures(result).map((a) => a.message ?? a.name);
  return result.error ? [...messages, result.error] : messages;
}

function softMessages(result: EvalResult): string[] {
  return softFailures(result).map((a) => a.message ?? a.name);
}

/**
 * The console summary: one row per eval case, totals, then gate failures
 * and soft failures listed separately.
 */
export function renderTable(results: readonly EvalResult[], strict: boolean): string {
  const summary = summarize(results, strict);
  const header = ['EVAL', 'CASE', 'RESULT', 'SCORES', 'DURATION'];
  const rows = results.map((r) => [r.name, r.case ?? '-', resultColumn(r, strict), scoresColumn(r), formatDuration(r.durationMs)]);
  const totals = `${summary.total} eval(s): ${summary.passed} passed, ${summary.failed} failed, ${summary.softFailed} with soft failures (${formatDuration(summary.durationMs)})`;
  const gateFailed = results.filter((r) => !r.passed);
  return [
    ...renderRows([header, ...rows]),
    '',
    totals,
    ...failureLines('Gate failures', gateFailed, gateMessages),
    ...failureLines(strict ? 'Soft failures (failing the run: --strict)' : 'Soft failures (not failing the run)', results, softMessages),
  ].join('\n');
}

/** One drifted field of one case (`lousho eval --drift`, LOU-D46). */
export interface DriftRow {
  result: EvalResult;
  /** A trajectory difference, or `cassette` when one side was never recorded. */
  entry: { field: DriftEntry['field'] | 'cassette'; committed: string; current: string };
}

/** The `--drift` section: one row per drifted field, committed value vs the fresh recording. */
export function renderDriftTable(rows: readonly DriftRow[]): string {
  if (rows.length === 0) return 'Drift: none (every recorded case matches its committed cassette).';
  const header = ['EVAL', 'CASE', 'FIELD', 'COMMITTED', 'CURRENT'];
  const body = rows.map(({ result, entry }) => [result.name, result.case ?? '-', entry.field, entry.committed, entry.current]);
  return ['Drift:', ...renderRows([header, ...body])].join('\n');
}

/** Machine-readable report: the summary plus every structured result. */
export function renderJson(results: readonly EvalResult[], strict: boolean): string {
  return `${JSON.stringify({ summary: summarize(results, strict), results }, null, 2)}\n`;
}

/** Drops control characters XML 1.0 cannot represent (everything below 0x20 except tab, LF, CR). */
function stripIllegalXml(text: string): string {
  return [...text].filter((ch) => ch.charCodeAt(0) >= 0x20 || '\t\n\r'.includes(ch)).join('');
}

function isErrorOnly(result: EvalResult): boolean {
  return Boolean(result.error) && gateFailures(result).length === 0;
}

function xml(text: string): string {
  return stripIllegalXml(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function seconds(ms: number): string {
  return (ms / 1000).toFixed(3);
}

function testcaseXml(result: EvalResult, strict: boolean): string {
  const open = `    <testcase classname="${xml(result.name)}" name="${xml(result.case ?? result.name)}" time="${seconds(result.durationMs)}"`;
  const gates = gateMessages(result);
  const softs = softMessages(result);
  if (isErrorOnly(result) && result.error) {
    return `${open}>\n      <error message="${xml(result.error)}" type="EvalError">${xml(result.error)}</error>\n    </testcase>`;
  }
  const failures = gates.length > 0 ? gates : strict ? softs : [];
  if (failures.length > 0) {
    return `${open}>\n      <failure message="${xml(failures[0])}" type="AssertionError">${xml(failures.join('\n'))}</failure>\n    </testcase>`;
  }
  if (softs.length > 0) {
    return `${open}>\n      <system-out>${xml(softs.map((m) => `soft failure: ${m}`).join('\n'))}</system-out>\n    </testcase>`;
  }
  return `${open} />`;
}

function counts(cases: readonly EvalResult[], strict: boolean): { failures: number; errors: number; time: string } {
  const errors = cases.filter(isErrorOnly).length;
  return {
    errors,
    failures: cases.filter((r) => failsRun(r, strict)).length - errors,
    time: seconds(cases.reduce((sum, r) => sum + r.durationMs, 0)),
  };
}

function suiteXml(name: string, cases: readonly EvalResult[], strict: boolean): string {
  const { failures, errors, time } = counts(cases, strict);
  const head = `  <testsuite name="${xml(name)}" tests="${cases.length}" failures="${failures}" errors="${errors}" skipped="0" time="${time}">`;
  return [head, ...cases.map((r) => testcaseXml(r, strict)), '  </testsuite>'].join('\n');
}

/**
 * JUnit XML (`testsuites` > `testsuite` per eval > `testcase` per case).
 * Gate failures carry the diagnostic message in `<failure>`; soft failures
 * are `<system-out>` notes, or failures under `strict`.
 */
export function renderJunit(results: readonly EvalResult[], strict: boolean): string {
  const byEval = new Map<string, EvalResult[]>();
  for (const result of results) byEval.set(result.name, [...(byEval.get(result.name) ?? []), result]);
  const { failures, errors, time } = counts(results, strict);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="lousho eval" tests="${results.length}" failures="${failures}" errors="${errors}" time="${time}">`,
    ...[...byEval].map(([name, cases]) => suiteXml(name, cases, strict)),
    '</testsuites>',
    '',
  ].join('\n');
}

/** The part of vitest's JSON report (`--reporter=json`) read here. */
interface VitestJsonReport {
  testResults?: Array<{
    name: string;
    status: string;
    message?: string;
    assertionResults?: Array<{ fullName?: string; title?: string; status: string; failureMessages?: string[] }>;
  }>;
}

function sameFile(a: string, b: string): boolean {
  const norm = (file: string) => {
    const resolved = path.resolve(file).split(path.sep).join('/');
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return norm(a) === norm(b);
}

function vitestError(label: string, message: string): EvalResult {
  return { name: 'vitest', case: label, tags: [], passed: false, assertions: [], durationMs: 0, steps: 0, toolCalls: [], error: message };
}

/**
 * Error results for what vitest failed without any eval case reporting it:
 * one per test file vitest marked failed (a file that failed to load, a test
 * outside `defineEval()`), else one for the whole run when vitest exited
 * non-zero with nothing failing. Without them a crashed run would write
 * empty (green-looking) JUnit and JSON reports.
 */
export function unreportedFailures(
  results: readonly EvalResult[],
  vitestReport: unknown,
  vitestCode: number,
  options: { cwd: string; strict: boolean }
): EvalResult[] {
  const failingFiles = results.filter((r) => failsRun(r, options.strict) && r.file).map((r) => r.file as string);
  const extra: EvalResult[] = [];
  for (const file of (vitestReport as VitestJsonReport | undefined)?.testResults ?? []) {
    if (file.status !== 'failed' || failingFiles.some((f) => sameFile(f, file.name))) continue;
    const failedTests = (file.assertionResults ?? []).filter((a) => a.status === 'failed');
    const message =
      file.message ||
      failedTests.map((a) => `${a.fullName ?? a.title ?? 'test'}: ${a.failureMessages?.[0] ?? 'failed'}`).join('\n') ||
      'vitest reported this file as failed';
    extra.push({ ...vitestError(path.relative(options.cwd, file.name).split(path.sep).join('/'), message), file: file.name });
  }
  if (vitestCode !== 0 && extra.length === 0 && !results.some((r) => failsRun(r, options.strict))) {
    extra.push(
      vitestError(
        'run',
        `vitest exited with code ${vitestCode} but no eval case failed: an eval file failed to load, a test outside defineEval() failed, or vitest crashed. See the vitest output above.`
      )
    );
  }
  return extra;
}
