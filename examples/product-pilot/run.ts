import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { mockModel } from 'lousho/testing';
import { DEFAULT_MAX_STEPS, parseArms } from './arms';
import { CASE_IDS } from './cases';
import { budgetOf, doneKeys, parseRows, runPilot, type PilotRow } from './pilot';
import { buildReport, formatReport } from './score';

const { values } = parseArgs({
  options: {
    model: { type: 'string' },
    arms: { type: 'string', default: 'flat,product,flat-plus' },
    cases: { type: 'string' },
    repeats: { type: 'string', default: '3' },
    'gap-ms': { type: 'string', default: '3500' },
    'max-tokens': { type: 'string', default: '300000' },
    'max-steps': { type: 'string', default: String(DEFAULT_MAX_STEPS) },
    cache: { type: 'string' },
    mock: { type: 'boolean', default: false },
  },
});

function pickCases(filter: string | undefined): string[] {
  if (filter === undefined) return [...CASE_IDS];
  const wanted = filter.split(',').map((id) => id.trim());
  const unknown = wanted.filter((id) => !CASE_IDS.includes(id));
  if (unknown.length > 0) throw new Error(`Unknown case: ${unknown.join(', ')}. Cases: ${CASE_IDS.join(', ')}.`);
  return wanted;
}

function count(flag: string, value: string, min: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min) throw new Error(`--${flag} must be a whole number of at least ${min}, not '${value}'.`);
  return parsed;
}

function chooseModel(): string {
  if (values.mock) return 'mock';
  if (process.env.OPENROUTER_API_KEY === undefined) throw new Error('Set OPENROUTER_API_KEY for a live run, or pass --mock.');
  if (values.model === undefined) throw new Error('Pass --model for a live run.');
  return values.model;
}

async function main(): Promise<void> {
  const model = chooseModel();
  const repeats = count('repeats', values.repeats, 1);
  const maxTokens = count('max-tokens', values['max-tokens'], 1);
  const maxSteps = count('max-steps', values['max-steps'], 1);
  const cache = values.cache;
  const previous = cache !== undefined && existsSync(cache) ? parseRows(readFileSync(cache, 'utf8')) : [];
  const rows = await runPilot({
    arms: parseArms(values.arms),
    cases: pickCases(values.cases),
    repeats,
    model,
    gapMs: count('gap-ms', values['gap-ms'], 0),
    maxTokens,
    maxSteps,
    done: doneKeys(previous),
    ...(values.mock && { provider: () => mockModel(['I cannot see the project.']) }),
    onRow: (row: PilotRow) => {
      if (cache !== undefined) appendFileSync(cache, `${JSON.stringify(row)}\n`);
      console.log(`${row.arm} ${row.case} #${row.repeat}: ${row.passed === null ? 'excluded' : row.passed ? 'passed' : 'failed'} (${row.ended}, ${row.tokens} tokens)`);
    },
  });
  console.log(`\n${formatReport(buildReport([...previous, ...rows].filter((row) => row.model === model && row.budget === budgetOf(maxSteps, maxTokens)), repeats))}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
