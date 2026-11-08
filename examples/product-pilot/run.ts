import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { mockModel } from 'lousho/testing';
import { parseArms } from './arms';
import { CASE_IDS } from './cases';
import { doneKeys, parseRows, runPilot, type PilotRow } from './pilot';
import { buildReport, formatReport } from './score';

const { values } = parseArgs({
  options: {
    model: { type: 'string' },
    arms: { type: 'string', default: 'flat,product' },
    cases: { type: 'string' },
    repeats: { type: 'string', default: '3' },
    'gap-ms': { type: 'string', default: '3500' },
    'max-tokens': { type: 'string', default: '300000' },
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

function chooseModel(): string {
  if (values.mock) return 'mock';
  if (process.env.OPENROUTER_API_KEY === undefined) throw new Error('Set OPENROUTER_API_KEY for a live run, or pass --mock.');
  if (values.model === undefined) throw new Error('Pass --model for a live run.');
  return values.model;
}

async function main(): Promise<void> {
  const model = chooseModel();
  const cache = values.cache;
  const previous = cache !== undefined && existsSync(cache) ? parseRows(readFileSync(cache, 'utf8')) : [];
  const rows = await runPilot({
    arms: parseArms(values.arms),
    cases: pickCases(values.cases),
    repeats: Number(values.repeats),
    model,
    gapMs: Number(values['gap-ms']),
    maxTokens: Number(values['max-tokens']),
    done: doneKeys(previous),
    ...(values.mock && { provider: () => mockModel(['I cannot see the project.']) }),
    onRow: (row: PilotRow) => {
      if (cache !== undefined) appendFileSync(cache, `${JSON.stringify(row)}\n`);
      console.log(`${row.arm} ${row.case} #${row.repeat}: ${row.passed === null ? 'excluded' : row.passed ? 'passed' : 'failed'} (${row.ended}, ${row.tokens} tokens)`);
    },
  });
  console.log(`\n${formatReport(buildReport([...previous, ...rows].filter((row) => row.model === model), Number(values.repeats)))}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
