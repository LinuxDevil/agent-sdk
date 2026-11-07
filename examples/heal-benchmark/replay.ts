import { appendFileSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { benchmarkProbe } from './probe';
import { cachedProbe, emptyCounts, type ProbeCounts } from './probeCache';
import { LABELS, replayRow, type RecordedRow, type ReplayLine } from './replayRows';

const { values } = parseArgs({
  options: {
    in: { type: 'string' },
    cache: { type: 'string' },
    confirm: { type: 'string', default: '6' },
    model: { type: 'string', default: 'nvidia/nemotron-3-ultra-550b-a55b:free' },
    agent: { type: 'string', default: 'coding-agent' },
    'gap-ms': { type: 'string', default: '3000' },
    out: { type: 'string' },
  },
});

const live = process.env.OPENROUTER_API_KEY !== undefined;
const probe = benchmarkProbe({ agent: values.agent, model: values.model, live, gapMs: Number(values['gap-ms']) });
const counts: Record<ReplayLine['label'], ProbeCounts> = { invariant: emptyCounts(), domain: emptyCounts(), compose: emptyCounts() };

function onlyLabel(row: RecordedRow, label: ReplayLine['label']): RecordedRow {
  const base = row.baseHarness;
  const harness = row.candidates?.[label] ?? base;
  return { ...row, candidates: { invariant: base, domain: base, compose: base, [label]: harness } };
}

async function replayFile(file: string, dir: string): Promise<void> {
  const rows = readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as RecordedRow);
  for (const row of rows) {
    for (const label of LABELS) {
      const cached = cachedProbe(probe, { dir, model: values.model, salt: `confirm-${row.attempt}`, counts: counts[label] });
      const lines = await replayRow(onlyLabel(row, label), cached, Number(values.confirm));
      for (const line of lines) if (values.out !== undefined) appendFileSync(values.out, `${JSON.stringify(line)}\n`);
    }
  }
}

async function main(): Promise<void> {
  if (values.in === undefined || values.cache === undefined) throw new Error('replay needs --in <rows.jsonl> and --cache <dir>.');
  await replayFile(values.in, values.cache);
  for (const label of LABELS) {
    const { planned, run, cached, excluded } = counts[label];
    console.log(`${label}: planned ${planned}, run ${run}, cached ${cached}, excluded ${excluded}`);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
