/**
 * typedoc-ratchet (Eve DUI-F18)
 *
 * TypeDoc covers every package.json `exports` entry (see typedoc.json). Many
 * exported symbols still have no doc comment. This script counts TypeDoc's
 * "does not have any documentation" warnings and fails when the count rises
 * above the checked-in baseline in scripts/typedoc-baseline.json, so the
 * number can only go down.
 *
 * Usage:
 *   npx tsx scripts/typedoc-ratchet.ts            exit 1 if the count rose
 *   npx tsx scripts/typedoc-ratchet.ts --update   write the current count as the new baseline
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..');
const BASELINE_FILE = path.join(REPO_ROOT, 'scripts', 'typedoc-baseline.json');

function countUndocumented(): number {
  const typedocBin = path.join(REPO_ROOT, 'node_modules', 'typedoc', 'bin', 'typedoc');
  const result = spawnSync(
    process.execPath,
    [typedocBin, '--emit', 'none', '--validation.notDocumented', 'true'],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  const output = `${result.stdout}\n${result.stderr}`;
  if (!/Found 0 errors/.test(output)) {
    throw new Error(`typedoc did not complete cleanly:\n${output.slice(-2000)}`);
  }
  return output.split('\n').filter((line) => line.includes('does not have any documentation'))
    .length;
}

function readBaseline(): number {
  const parsed = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')) as { notDocumented: number };
  return parsed.notDocumented;
}

function main(): void {
  const current = countUndocumented();
  if (process.argv.includes('--update')) {
    fs.writeFileSync(BASELINE_FILE, `${JSON.stringify({ notDocumented: current }, null, 2)}\n`);
    console.log(`typedoc baseline set to ${current}`);
    return;
  }
  const baseline = readBaseline();
  if (current > baseline) {
    console.error(
      `typedoc: ${current} undocumented exports, baseline is ${baseline}. ` +
        'Add a doc comment to the new export (the ratchet only goes down).',
    );
    process.exit(1);
  }
  if (current < baseline) {
    console.log(
      `typedoc: ${current} undocumented exports (baseline ${baseline}). ` +
        'Run `npm run docs:ratchet:update` and commit scripts/typedoc-baseline.json to lock the gain.',
    );
    return;
  }
  console.log(`typedoc: ${current} undocumented exports (at baseline).`);
}

main();
