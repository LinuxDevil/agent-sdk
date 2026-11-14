import { parseArgs } from 'node:util';
import { improveAgent, type Harness, type ImproveOptions } from '@linuxdevil/lousho/improve';
import { armsFromResult, harnessKey, noOpHarness, plantedHarness, scriptedEditor, type Arm } from './gates';

const { values } = parseArgs({
  options: {
    trials: { type: 'string', default: '2000' },
    seed: { type: 'string', default: '1' },
    'training-rate': { type: 'string', default: '0.2' },
    'fix-rate': { type: 'string', default: '0.8' },
    'holdout-rates': { type: 'string', default: '1,0.95' },
    repeats: { type: 'string', default: '3' },
  },
});

const BASE: Harness = { instructions: 'You fix bugs in a small JavaScript project.', skills: {} };
const FIX: Harness = { instructions: `${BASE.instructions} Keep the original day when a month is shorter.`, skills: {} };
const KINDS = { 'true fix': FIX, 'no-op': noOpHarness(BASE), planted: plantedHarness(BASE) };
const GATES: readonly Arm[] = ['B', 'C', 'D'];
const TRAINING = 'training';

const trainingRate = Number(values['training-rate']);
const fixRate = Number(values['fix-rate']);
const holdoutRates = values['holdout-rates'].split(',').map(Number);
const holdout = holdoutRates.map((_, index) => `held-out-${index + 1}`);

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function passRate(harness: Harness, caseId: string): number {
  const key = harnessKey(harness);
  if (caseId === TRAINING) return key === harnessKey(FIX) ? fixRate : trainingRate;
  const index = holdout.indexOf(caseId);
  return key === harnessKey(KINDS.planted) && index === 0 ? 0 : holdoutRates[index];
}

function bernoulliProbe(random: () => number): ImproveOptions['probe'] {
  return async (harness, caseId) => ({ passed: random() < passRate(harness, caseId), transcript: `Ran ${caseId}.`, tokens: 1000, ended: 'stop' });
}

async function acceptance(candidate: Harness, trials: number, random: () => number): Promise<Record<string, number>> {
  const accepted: Record<string, number> = Object.fromEntries(GATES.map((arm) => [arm, 0]));
  for (let trial = 0; trial < trials; trial += 1) {
    const result = await improveAgent({
      harness: BASE,
      cases: [TRAINING],
      holdout,
      probe: bernoulliProbe(random),
      editor: scriptedEditor(BASE, { invariant: BASE, domain: BASE, compose: candidate }),
      repeats: Number(values.repeats),
      alwaysPropose: true,
    });
    for (const row of armsFromResult(trial, result, BASE)) if (row.accepted && GATES.includes(row.arm)) accepted[row.arm] += 1;
  }
  return accepted;
}

async function main(): Promise<void> {
  const trials = Number(values.trials);
  const random = mulberry32(Number(values.seed));
  console.log(`${trials} trials a kind, seed ${values.seed}; training ${trainingRate} (fix ${fixRate}), held-out ${holdoutRates.join(', ')}, ${values.repeats} repeats.`);
  console.log('| Harness | B: old gate | C: gate v2 | D: v2 plus fallback |');
  console.log('| --- | --- | --- | --- |');
  for (const [kind, candidate] of Object.entries(KINDS)) {
    const accepted = await acceptance(candidate, trials, random);
    console.log(`| ${kind} | ${GATES.map((arm) => (accepted[arm] / trials).toFixed(3)).join(' | ')} |`);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
