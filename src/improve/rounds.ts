import { evidenceFiles, type LabelledRun } from './evidence';
import { diffHarness } from './harness';
import type { Proposal } from './judge';
import { candidateFiles, evidenceNote, failedChecks, notesFile, propose, type Proposer } from './proposals';
import { composeRoundPrompt, DOMAIN_PROMPT, INVARIANT_PROMPT, roundNote } from './prompts';
import type { ImproveRun } from './run';
import type { Harness, ImproveOptions, ImproveResult } from './types';

interface Rounds {
  composed: Harness;
  pool: Proposal[];
  checkpoints: Proposal[];
  result?: Omit<ImproveResult, 'base' | 'stages' | 'spend'>;
}

interface Round {
  round: number;
  rounds: number;
  current: Harness;
  history: Proposal[];
  checkpoints: Proposal[];
}

function historyFiles(run: ImproveRun, base: Harness, proposals: readonly Proposal[]): Record<string, string> {
  const notes = (label: string) => {
    const stage = run.stages.find((entry) => entry.label === label);
    return stage?.status === 'fell-back' ? `No change was kept: the edit was rejected. ${stage.error ?? ''}`.trim() : (stage?.notes ?? '');
  };
  return Object.assign({}, ...proposals.map(({ label, harness }) => ({ ...candidateFiles(label, base, harness), [`context/candidates/${label}/notes.md`]: notesFile(notes(label)) })));
}

const runsOf = (baseRuns: readonly LabelledRun[], proposals: readonly Proposal[]) => [...baseRuns, ...proposals.flatMap((proposal) => proposal.runs)];

function roundEvidence(run: ImproveRun, options: ImproveOptions, baseRuns: readonly LabelledRun[], current: Harness, proposals: readonly Proposal[]): Record<string, string> {
  const { harness: base, recoveries, library } = options;
  return evidenceFiles({ harness: current, runs: runsOf(baseRuns, proposals), recoveries, extra: { ...library, ...historyFiles(run, base, proposals) } });
}

function candidatesOf(history: readonly Proposal[], compose: Harness): NonNullable<ImproveResult['candidates']> {
  return { invariant: history[0].harness, domain: history[1].harness, compose, pool: Object.fromEntries(history.map((entry) => [entry.label, entry.harness])) };
}

async function runRound(run: ImproveRun, options: ImproveOptions, baseRuns: readonly LabelledRun[], state: Round): Promise<Harness> {
  const { round, rounds, current, history, checkpoints } = state;
  const note = evidenceNote(options);
  const proposers: Proposer[] = [
    { label: `invariant-${round}`, system: INVARIANT_PROMPT + note + roundNote(round, rounds) },
    { label: `domain-${round}`, system: DOMAIN_PROMPT + note + roundNote(round, rounds) },
  ];
  const proposals = await propose(run, options, proposers, roundEvidence(run, options, baseRuns, current, history), { from: current, seen: runsOf(baseRuns, history) });
  history.push(...proposals);
  run.candidates = candidatesOf(history, current);
  const label = `compose-${round}` as const;
  const composed = await run.edit(run.stage(label), composeRoundPrompt(round, rounds) + note, roundEvidence(run, options, baseRuns, current, history), current, { failedChecks: failedChecks(runsOf(baseRuns, history)) });
  const unseen = diffHarness(options.harness, composed) !== '' && checkpoints.every((checkpoint) => diffHarness(checkpoint.harness, composed) !== '');
  const runs = unseen ? await run.probe(composed, label, options.cases, 0, run.repeats) : [];
  const checkpoint = { label, harness: composed, runs };
  history.push(checkpoint);
  checkpoints.push(checkpoint);
  run.candidates = candidatesOf(history, composed);
  return composed;
}

export async function runRounds(run: ImproveRun, options: ImproveOptions, baseRuns: readonly LabelledRun[]): Promise<Rounds> {
  const rounds = options.proposers ?? 1;
  const state: Round = { round: 1, rounds, current: options.harness, history: [], checkpoints: [] };
  for (; state.round <= rounds; state.round += 1) state.current = await runRound(run, options, baseRuns, state);
  const stages = { composed: state.current, pool: state.history, checkpoints: state.checkpoints };
  if (state.checkpoints.every((checkpoint) => diffHarness(options.harness, checkpoint.harness) === '')) return { ...stages, result: { outcome: 'keep-base', reason: 'The editors made no change.' } };
  return stages;
}
