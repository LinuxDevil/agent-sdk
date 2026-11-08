import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { parseRows } from './pilot';
import { buildReport, formatReport } from './score';

const { values } = parseArgs({
  options: {
    in: { type: 'string' },
    model: { type: 'string' },
    k: { type: 'string', default: '3' },
    json: { type: 'boolean', default: false },
  },
});

function main(): void {
  if (values.in === undefined) throw new Error('Pass --in <rows.jsonl>.');
  const rows = parseRows(readFileSync(values.in, 'utf8')).filter((row) => values.model === undefined || row.model === values.model);
  const report = buildReport(rows, Number(values.k));
  console.log(values.json ? JSON.stringify(report, null, 2) : formatReport(report));
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
