/**
 * `npm run eval:author` - runs the 16 scripted Author conversations in
 * `evals/author/scenarios/` through the real server path (harness.ts →
 * `createAuthorServices`, the same bundle `createApp` builds), applies the
 * hard checks plus a judged rubric, writes `results/<date>.json`, and
 * fails when the pass rate drops more than 5 points below `baseline.json`
 * or any safety check failed.
 *
 * Flags:
 *   --mock              scripted mock model: plumbing only, no rubric, no baseline compare
 *   --only <name,name>  run just these scenarios
 *   --update-baseline   write this run's pass rate as the new baseline.json
 *   --no-review         pass the always-approve draft review (speed)
 *
 * Real mode needs the Author key (stored secrets or the provider env key);
 * the rubric judge runs on the configured review model, never the Author
 * model under test.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LLMProvider } from '@linuxdevil/lousho';
import type { AuthorMessage, AuthorSettings } from '../../shared/authorWire';
import { SecretsStore } from '../../server/secretsStore';
import { passReview } from '../../server/author/proposal/review';
import { resolveAuthorProvider } from '../../server/author/provider';
import { readAuthorSettings } from '../../server/author/settings';
import { SettingsStore } from '../../server/settingsStore';
import { studioPathsFor } from '../../server/workspace/studioPaths';
import { loadScenarios, type AuthorScenario, type LoadedScenario } from './scenario';
import { isSafetyCheck, runHardChecks, type HardCheckResult } from './checks';
import { comparePassRate, type AuthorEvalBaseline } from './compare';
import { judgeTranscript, type JudgeVerdict } from './judge';
import { evalMockProvider, runAuthorScenario } from './harness';

/** How many scenarios run at once. */
const CONCURRENCY = 3;

/** The eval's own directory (`evals/author`), whichever cwd the script runs from. */
const EVAL_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCENARIOS_DIR = path.join(EVAL_DIR, 'scenarios');
const FIXTURES_DIR = path.join(EVAL_DIR, 'fixtures');
const RESULTS_DIR = path.join(EVAL_DIR, 'results');
const BASELINE_PATH = path.join(EVAL_DIR, 'baseline.json');

/** The repo root's `.lousho`: real mode's Studio-global stores (settings, secrets). */
const REPO_GLOBAL_HOME = path.resolve(EVAL_DIR, '..', '..', '..', '..', '.lousho');

interface CliFlags {
  mock: boolean;
  only: string[] | undefined;
  updateBaseline: boolean;
  noReview: boolean;
}

function parseFlags(argv: string[]): CliFlags {
  const flags: CliFlags = { mock: false, only: undefined, updateBaseline: false, noReview: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--mock') flags.mock = true;
    else if (arg === '--update-baseline') flags.updateBaseline = true;
    else if (arg === '--no-review') flags.noReview = true;
    else if (arg === '--only') {
      const value = argv[++i];
      if (value === undefined) throw new Error('--only needs a comma-separated list of scenario names');
      flags.only = value.split(',').map((name) => name.trim()).filter(Boolean);
    } else if (arg.startsWith('--only=')) {
      flags.only = arg.slice('--only='.length).split(',').map((name) => name.trim()).filter(Boolean);
    } else {
      throw new Error(`unknown flag: ${arg}`);
    }
  }
  return flags;
}

/** One results-file scenario row. */
interface ScenarioResultRow {
  name: string;
  pass: boolean;
  hardChecks: HardCheckResult[];
  rubric: JudgeVerdict | null;
  toolCalls: string[];
  durationMs: number;
  error?: string;
}

/** The results file's top-level shape. */
interface EvalResultsFile {
  date: string;
  mode: 'real' | 'mock';
  model: string;
  reviewModel: string;
  passRate: number;
  scenarios: ScenarioResultRow[];
}

/** Runs one scenario to a results row: harness, hard checks, rubric (real mode). */
async function runOne(
  scenario: AuthorScenario,
  deps: {
    mock: boolean;
    noReview: boolean;
    judge?: { provider: LLMProvider; modelId: string };
    globalHome: string;
  }
): Promise<ScenarioResultRow> {
  // One mock instance per scenario: its tool-call ids stay unique across
  // turns and its pending-call queue survives every `providerFor` call.
  const mockProvider = deps.mock ? evalMockProvider(scenario) : undefined;
  const outcome = await runAuthorScenario(scenario, {
    fixturesDir: FIXTURES_DIR,
    globalHome: deps.globalHome,
    ...(mockProvider !== undefined ? { providerFor: () => mockProvider } : {}),
    ...(deps.noReview ? { reviewDraft: passReview } : {}),
  });
  const hardChecks = runHardChecks(scenario.expect, outcome.collected);
  const { rubric, error } = await gradeOutcome(scenario, outcome, deps);
  const pass =
    error === undefined && hardChecks.every((check) => check.pass) && (rubric === null || rubric.score >= 1);
  return {
    name: scenario.name,
    pass,
    hardChecks,
    rubric,
    toolCalls: outcome.toolCallNames,
    durationMs: outcome.durationMs,
    ...(error !== undefined && { error }),
  };
}

/**
 * The judged half of a scenario: the rubric verdict plus any execution
 * error (harness or judge). Mock mode never judges - rubric stays null.
 */
async function gradeOutcome(
  scenario: AuthorScenario,
  outcome: { transcript: AuthorMessage[]; error?: string },
  deps: { mock: boolean; judge?: { provider: LLMProvider; modelId: string } }
): Promise<{ rubric: JudgeVerdict | null; error: string | undefined }> {
  if (deps.mock || outcome.error !== undefined || deps.judge === undefined) {
    return { rubric: null, error: outcome.error };
  }
  try {
    const rubric = await judgeTranscript(deps.judge.provider, deps.judge.modelId, outcome.transcript, scenario.expect.rubric);
    return { rubric, error: outcome.error };
  } catch (judgeError) {
    return { rubric: null, error: `judge failed: ${judgeError instanceof Error ? judgeError.message : String(judgeError)}` };
  }
}

/** `await`s the work queue with `CONCURRENCY` workers, preserving submission order in `out`. */
async function runPool<T, R>(items: readonly T[], work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      out[index] = await work(items[index]);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Reads `baseline.json`, or `undefined` when absent/unreadable. */
function readBaseline(): AuthorEvalBaseline | undefined {
  try {
    const data: unknown = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
    if (typeof data === 'object' && data !== null && typeof (data as { passRate?: unknown }).passRate === 'number') {
      return data as AuthorEvalBaseline;
    }
  } catch {
    /* absent or unreadable - no baseline */
  }
  return undefined;
}

/** The scenarios `--only` selects, or a named-missing list error printed for the caller. */
function selectScenarios(loaded: LoadedScenario[], only: string[] | undefined): LoadedScenario[] | undefined {
  if (only === undefined) return loaded;
  const scenarios = loaded.filter((entry) => only.includes(entry.scenario.name));
  const missing = only.filter((name) => !scenarios.some((entry) => entry.scenario.name === name));
  if (missing.length > 0) {
    console.error(`Unknown scenario(s): ${missing.join(', ')}`);
    return undefined;
  }
  return scenarios;
}

/**
 * Real mode's providers: the Author model checked up front (a missing key
 * exits fast instead of failing 16 turns) and the review model the rubric
 * judge runs on. `undefined` in mock mode, an exit code on failure.
 */
function resolveRealProviders(
  authorSettings: AuthorSettings,
  secrets: SecretsStore
): { judge: { provider: LLMProvider; modelId: string } } | { exitCode: number } {
  const authorResolved = resolveAuthorProvider(authorSettings.model, secrets);
  if (!authorResolved.ok) {
    console.error(`Cannot run the Author eval: ${authorResolved.message}`);
    return { exitCode: 2 };
  }
  const reviewResolved = resolveAuthorProvider(authorSettings.reviewModel, secrets);
  if (!reviewResolved.ok) {
    console.error(`Cannot judge the Author eval: ${reviewResolved.message}`);
    return { exitCode: 2 };
  }
  return { judge: { provider: reviewResolved.provider, modelId: reviewResolved.modelId } };
}

/** Resolves real-mode providers and prints the run header; `{ exitCode }` when a key is missing. */
function prepareRun(
  flags: CliFlags,
  mode: 'real' | 'mock',
  authorSettings: AuthorSettings,
  secrets: SecretsStore,
  scenarioCount: number
): { judge?: { provider: LLMProvider; modelId: string } } | { exitCode: number } {
  let judge: { provider: LLMProvider; modelId: string } | undefined;
  if (mode === 'real') {
    const resolved = resolveRealProviders(authorSettings, secrets);
    if ('exitCode' in resolved) return resolved;
    judge = resolved.judge;
  }
  console.log(
    `Author eval (${mode}): ${scenarioCount} scenario(s), model ${mode === 'mock' ? 'mock' : authorSettings.model}` +
      `${mode === 'mock' ? '' : `, judge ${authorSettings.reviewModel}`}${flags.noReview ? ', draft review off' : ''}`
  );
  return { ...(judge !== undefined && { judge }) };
}

/** Writes `results/<date>.json` and returns the pass rate. */
function writeResultsFile(mode: 'real' | 'mock', authorSettings: AuthorSettings, rows: ScenarioResultRow[]): number {
  const passRate = rows.length === 0 ? 0 : rows.filter((row) => row.pass).length / rows.length;
  const date = new Date().toISOString().slice(0, 10);
  const results: EvalResultsFile = {
    date,
    mode,
    model: mode === 'mock' ? 'mock' : authorSettings.model,
    reviewModel: mode === 'mock' ? 'mock' : authorSettings.reviewModel,
    passRate,
    scenarios: rows,
  };
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const resultsPath = path.join(RESULTS_DIR, `${date}.json`);
  fs.writeFileSync(resultsPath, `${JSON.stringify(results, null, 2)}\n`);
  console.log(`Wrote ${resultsPath} (pass rate ${(passRate * 100).toFixed(1)}%)`);
  return passRate;
}

/** Runs every selected scenario at CONCURRENCY 3, printing a PASS/FAIL line each. */
async function runAllScenarios(
  scenarios: LoadedScenario[],
  flags: CliFlags,
  judge: { provider: LLMProvider; modelId: string } | undefined,
  globalHome: string
): Promise<ScenarioResultRow[]> {
  return runPool(scenarios, (entry: LoadedScenario) =>
    runOne(entry.scenario, {
      mock: flags.mock,
      noReview: flags.noReview,
      ...(judge !== undefined && { judge }),
      globalHome,
    }).then((row) => {
      const marker = row.pass ? 'PASS' : 'FAIL';
      const detail = row.error !== undefined ? ` (${row.error})` : '';
      console.log(`  ${marker} ${row.name}${detail}`);
      return row;
    })
  );
}

/** The baseline step: `--update-baseline` writes it, else compare (real mode only). */
function compareOrUpdateBaseline(flags: CliFlags, mode: 'real' | 'mock', model: string, passRate: number): boolean {
  if (mode !== 'real') return true;
  const date = new Date().toISOString().slice(0, 10);
  if (flags.updateBaseline) {
    const baseline: AuthorEvalBaseline = { passRate, date, model };
    fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
    console.log(`Updated baseline.json to ${(passRate * 100).toFixed(1)}%`);
    return true;
  }
  const outcome = comparePassRate(passRate, readBaseline());
  console.log(`Baseline compare: ${outcome.detail}`);
  return outcome.ok;
}

async function main(): Promise<number> {
  const flags = parseFlags(process.argv.slice(2));
  const scenarios = selectScenarios(loadScenarios(SCENARIOS_DIR), flags.only);
  if (scenarios === undefined) return 2;
  const mode = flags.mock ? 'mock' : 'real';

  // Real mode: settings/secrets come from the repo's .lousho so the
  // configured Author model + key apply; mock mode never touches them.
  const globalHome = REPO_GLOBAL_HOME;
  const globalPaths = studioPathsFor(globalHome);
  const secrets = new SecretsStore(globalPaths);
  const authorSettings = readAuthorSettings(new SettingsStore(globalPaths));

  const prepared = prepareRun(flags, mode, authorSettings, secrets, scenarios.length);
  if ('exitCode' in prepared) return prepared.exitCode;
  const rows = await runAllScenarios(scenarios, flags, prepared.judge, globalHome);
  const passRate = writeResultsFile(mode, authorSettings, rows);

  const safetyFailed = rows.some(
    (row) => row.error !== undefined || row.hardChecks.some((check) => isSafetyCheck(check) && !check.pass)
  );
  const baselineOk = compareOrUpdateBaseline(flags, mode, mode === 'mock' ? 'mock' : authorSettings.model, passRate);

  return safetyFailed || !baselineOk ? 1 : 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  });
