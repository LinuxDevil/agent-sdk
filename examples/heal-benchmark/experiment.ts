import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { improveAgent, type Harness, type ImproveResult } from 'lousho/improve';
import { renderReport, trueFixAttempts, type Confirmation } from './armSummary';
import { admitHoldout, armRow, armsFromResult, loggedProbe, noOpHarness, plantedHarness, scriptedEditor, type Arm, type ArmContext, type ArmRow, type LoggedRun } from './gates';
import { benchmarkProbe, buildAgent } from './probe';
import { admissionFailure, replayable, requireModels } from './experimentRules';
import { cachedProbe, emptyCounts, type ProbeCounts } from './probeCache';
import { assertRowModel, type RecordedRow, type ReplayLine } from './replayRows';

const { values } = parseArgs({
  options: {
    in: { type: 'string' },
    truth: { type: 'string' },
    healthy: { type: 'string' },
    cache: { type: 'string' },
    arms: { type: 'string', default: 'A,B,C,D,N,P' },
    attempts: { type: 'string', default: '10' },
    agent: { type: 'string', default: 'coding-agent' },
    case: { type: 'string', multiple: true, default: ['add-months'] },
    holdout: { type: 'string', multiple: true, default: ['page-count', 'dedupe-first'] },
    repeats: { type: 'string', default: '3' },
    model: { type: 'string' },
    editor: { type: 'string' },
    'gap-ms': { type: 'string', default: '3000' },
    'max-tokens': { type: 'string', default: '400000' },
    admit: { type: 'boolean', default: false },
    out: { type: 'string' },
  },
});

function modelsOrExit(): { model: string; editor: string } {
  try {
    return requireModels(values);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return process.exit(1);
  }
}

const { model, editor } = modelsOrExit();
const ADMIT_RUNS = 6;
const live = process.env.OPENROUTER_API_KEY !== undefined;
const cacheModel = live ? model : `mock:${model}`;
const repeats = Number(values.repeats);
const arms = values.arms.split(',').map((arm) => arm.trim()) as Arm[];
const probe = benchmarkProbe({ agent: values.agent, model, live, gapMs: Number(values['gap-ms']) });
const counts: Record<string, ProbeCounts> = { admit: emptyCounts(), 'A-D': emptyCounts(), confirm: emptyCounts(), N: emptyCounts(), P: emptyCounts() };

type Row = RecordedRow & Partial<ImproveResult>;

function probeFor(salt: string, bucket: string, distinct = false) {
  if (values.cache === undefined) throw new Error('experiment needs --cache <dir>.');
  return cachedProbe(probe, { dir: values.cache, model: cacheModel, salt, counts: counts[bucket], distinct });
}

function readJsonl<T>(file: string | undefined): T[] {
  if (file === undefined) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as T);
}

async function admit(base: Harness): Promise<void> {
  const admitted = await admitHoldout(probeFor('admit', 'admit'), base, values.holdout, ADMIT_RUNS);
  for (const { caseId, passed, scored } of admitted) console.log(`${caseId}: ${passed}/${scored}${passed < ADMIT_RUNS ? ', below 6/6, so not admitted' : ''}`);
  if (admitted.some(({ passed }) => passed < ADMIT_RUNS)) process.exitCode = 2;
}

async function runGates(base: Harness, recorded: NonNullable<RecordedRow['candidates']>, setup: { salt: string; bucket: string; cases: readonly string[]; holdout: readonly string[]; budget?: { maxTokens: number } }) {
  const log: LoggedRun[] = [];
  const result = await improveAgent({
    harness: base,
    cases: setup.cases,
    holdout: setup.holdout,
    probe: loggedProbe(probeFor(setup.salt, setup.bucket, true), log),
    editor: scriptedEditor(base, recorded),
    repeats,
    ...setup.budget,
    alwaysPropose: true,
  });
  return { result, log };
}

async function confirmProposal(row: Row, result: ImproveResult): Promise<Confirmation[]> {
  if (!arms.includes('D') || !result.harness) return [];
  const confirmed = await admitHoldout(probeFor(`confirm-${row.attempt}`, 'confirm'), result.harness, row.holdout, ADMIT_RUNS);
  return confirmed.map((count) => ({ attempt: row.attempt, ...count }));
}

async function replayAttempt(row: Row): Promise<{ rows: ArmRow[]; confirmations: Confirmation[] }> {
  assertRowModel(row, model);
  const base = row.baseHarness;
  const recorded = row.candidates ?? { invariant: base, domain: base, compose: base };
  const { result, log } = await runGates(base, recorded, { salt: `attempt-${row.attempt}`, bucket: 'A-D', cases: row.cases, holdout: row.holdout });
  const context: ArmContext = { model: row.model, date: row.date, log, cases: row.cases, holdout: row.holdout, repeats };
  const rows = armsFromResult(row.attempt, result, base, context).filter((armRow) => arms.includes(armRow.arm));
  console.log(`attempt ${row.attempt}: ${rows.map((armRow) => `${armRow.arm} ${armRow.accepted ? 'accepted' : 'rejected'}`).join(', ')}.`);
  return { rows, confirmations: await confirmProposal(row, result) };
}

async function controlAttempt(arm: 'N' | 'P', attempt: number, base: Harness): Promise<ArmRow> {
  const compose = arm === 'N' ? noOpHarness(base) : plantedHarness(base);
  const { result, log } = await runGates(base, { invariant: base, domain: base, compose }, { salt: `attempt-${attempt}`, bucket: arm, cases: values.case, holdout: values.holdout, budget: { maxTokens: Number(values['max-tokens']) } });
  const context: ArmContext = { model, date: new Date().toISOString().slice(0, 10), log, cases: values.case, holdout: values.holdout, repeats };
  const row = armRow(arm, attempt, { accepted: result.outcome === 'proposal', reason: result.reason, shipped: result.harness ?? compose }, base, context);
  console.log(`${arm} attempt ${attempt}: ${row.accepted ? 'accepted' : 'rejected'}. ${row.reason}`);
  return row;
}

function replays(): Row[] {
  if (!arms.some((arm) => ['A', 'B', 'C', 'D'].includes(arm))) return [];
  const { kept, skipped } = replayable(readJsonl<Row>(values.in));
  for (const line of skipped) console.log(`skipped ${line}; only proposal and keep-base rows are replayed.`);
  return kept;
}

async function admittedForControls(base: Harness): Promise<boolean> {
  if (!arms.includes('N') && !arms.includes('P')) return true;
  const failure = admissionFailure(await admitHoldout(probeFor('admit', 'admit'), base, values.holdout, ADMIT_RUNS), ADMIT_RUNS);
  if (failure === undefined) return true;
  console.error(failure);
  process.exitCode = 2;
  return false;
}

async function runArms(base: Harness): Promise<{ rows: ArmRow[]; confirmations: Confirmation[] }> {
  const rows: ArmRow[] = [];
  const confirmations: Confirmation[] = [];
  for (const row of replays()) {
    const replayed = await replayAttempt(row);
    rows.push(...replayed.rows);
    confirmations.push(...replayed.confirmations);
  }
  const controls = (['N', 'P'] as const).filter((arm) => arms.includes(arm));
  for (const arm of controls) for (let attempt = 0; attempt < Number(values.attempts); attempt += 1) rows.push(await controlAttempt(arm, attempt, base));
  return { rows, confirmations };
}

async function main(): Promise<void> {
  const base: Harness = { instructions: buildAgent(values.agent).instructions, skills: {} };
  console.log(`model ${model}${live ? '' : ' (mock, no key)'}; editors are replayed from recorded rows, so --editor ${editor} makes no calls.`);
  if (values.admit) return admit(base);
  if (!(await admittedForControls(base))) return;
  if (values.out !== undefined) writeFileSync(values.out, '');
  const { rows, confirmations } = await runArms(base);
  if (values.out !== undefined) for (const row of rows) appendFileSync(values.out, `${JSON.stringify(row)}\n`);
  const healthy = readJsonl<{ outcome: string }>(values.healthy);
  const trueFixes = trueFixAttempts(readJsonl<ReplayLine>(values.truth));
  console.log(renderReport({ rows, trueFixes, confirmations, healthy, arms }, counts));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
