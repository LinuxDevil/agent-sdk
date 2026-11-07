import { appendFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { improveAgent, type Harness, type ImproveOptions } from 'lousho/improve';
import { mockModel } from 'lousho/testing';
import { benchmarkProbe, buildAgent, throttleHook } from './probe';
import { cachedProbe, emptyCounts } from './probeCache';
import { confirmHarness, replayRow, type RecordedRow, type ReplayLine } from './replayRows';

const { values } = parseArgs({
  options: {
    agent: { type: 'string', default: 'doc-qa' },
    case: { type: 'string', multiple: true, default: ['forbidden-doc'] },
    holdout: { type: 'string', multiple: true, default: [] },
    model: { type: 'string', default: 'nvidia/nemotron-3-ultra-550b-a55b:free' },
    editor: { type: 'string', default: 'nvidia/nemotron-3.5-super-vl:free' },
    attempts: { type: 'string', default: '1' },
    'first-attempt': { type: 'string', default: '0' },
    repeats: { type: 'string', default: '3' },
    confirm: { type: 'string', default: '0' },
    'confirm-candidates': { type: 'boolean', default: false },
    cache: { type: 'string' },
    'max-tokens': { type: 'string', default: '400000' },
    'max-cost-increase': { type: 'string' },
    'always-propose': { type: 'boolean', default: false },
    'gap-ms': { type: 'string', default: '3000' },
    out: { type: 'string' },
  },
});

const live = process.env.OPENROUTER_API_KEY !== undefined;
const gapMs = Number(values['gap-ms']);
const confirmRuns = Number(values.confirm);
const costLimit = values['max-cost-increase'] === undefined ? {} : { maxCostIncrease: Number(values['max-cost-increase']) };
const throttle = throttleHook(gapMs);
const probe = benchmarkProbe({ agent: values.agent, model: values.model, live, gapMs });
const scripted = mockModel(["<notes>KEEP_BASE. The runs don't argue for a change.</notes>"], { onExhausted: 'repeat-last' });

function probeFor(salt: string, distinct = false): ImproveOptions['probe'] {
  if (values.cache === undefined) return probe;
  const model = live ? values.model : `mock:${values.model}`;
  return cachedProbe(probe, { dir: values.cache, model, salt, counts: emptyCounts(), distinct });
}

async function confirmCandidates(row: RecordedRow): Promise<Partial<Record<ReplayLine['label'], { passed: number; scored: number }>>> {
  const lines = await replayRow(row, probeFor(`confirm-${row.attempt}`), confirmRuns);
  return Object.fromEntries(lines.map(({ label, passed, scored }) => [label, { passed, scored }]));
}

async function runAttempt(attempt: number, base: Harness): Promise<void> {
  const result = await improveAgent({
    harness: base,
    cases: values.case,
    holdout: values.holdout,
    probe: probeFor(`attempt-${attempt}`, true),
    editor: live ? { model: `openrouter/${values.editor}` } : { provider: scripted },
    repeats: Number(values.repeats),
    maxTokens: Number(values['max-tokens']),
    ...costLimit,
    alwaysPropose: values['always-propose'],
    editorHooks: live ? [throttle] : [],
  });
  const confirmed = result.harness && confirmRuns > 0 ? await confirmHarness(probeFor(`confirm-${attempt}`), result.harness, values.case, confirmRuns) : undefined;
  const recorded: RecordedRow = { attempt, cases: values.case, holdout: values.holdout, model: values.model, date: new Date().toISOString().slice(0, 10), baseHarness: base };
  const candidatesConfirmed = values['confirm-candidates'] && confirmRuns > 0 ? await confirmCandidates({ ...recorded, ...(result.candidates && { candidates: result.candidates }) }) : undefined;
  const { cases: caseVerdicts, holdout: holdoutSummary, ...rest } = result;
  const row = { ...rest, ...recorded, caseVerdicts, holdoutSummary, confirmed, candidatesConfirmed };
  if (values.out !== undefined) appendFileSync(values.out, `${JSON.stringify(row)}\n`);
  console.log(`attempt ${attempt}: ${result.outcome}. ${result.reason} ${result.spend.tokens} tokens.`);
  if (result.diff) console.log(result.diff);
  if (confirmed) console.log(`confirmed on fresh runs: ${confirmed.passed}/${confirmed.scored}`);
}

async function main(): Promise<void> {
  const base: Harness = { instructions: buildAgent(values.agent).instructions, skills: {} };
  const first = Number(values['first-attempt']);
  for (let attempt = first; attempt < first + Number(values.attempts); attempt += 1) await runAttempt(attempt, base);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
