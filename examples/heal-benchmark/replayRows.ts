import type { Harness, ImproveOptions } from 'lousho/improve';

export interface RecordedRow {
  attempt: number;
  cases: string[];
  holdout: string[];
  model: string;
  date: string;
  baseHarness: Harness;
  candidates?: { invariant: Harness; domain: Harness; compose: Harness };
}

export interface ReplayLine {
  attempt: number;
  label: 'invariant' | 'domain' | 'compose';
  passed: number;
  scored: number;
  containsFix: boolean;
}

export const LABELS = ['invariant', 'domain', 'compose'] as const;

export function assertRowModel(row: Pick<RecordedRow, 'attempt'> & { model?: string }, model: string): void {
  if (row.model && row.model !== model) throw new Error(`row ${row.attempt} was recorded with ${row.model}`);
}

export async function confirmHarness(probe: ImproveOptions['probe'], harness: Harness, caseIds: readonly string[], runs: number): Promise<{ passed: number; scored: number }> {
  let passed = 0;
  let scored = 0;
  for (let repeat = 0; repeat < runs; repeat += 1) {
    for (const caseId of caseIds) {
      const run = await probe(harness, caseId, repeat);
      if (run.passed === null) continue;
      scored += 1;
      if (run.passed) passed += 1;
    }
  }
  return { passed, scored };
}

export async function replayRow(row: RecordedRow, probe: ImproveOptions['probe'], confirm: number): Promise<ReplayLine[]> {
  const lines: ReplayLine[] = [];
  const base = JSON.stringify(row.baseHarness);
  for (const label of LABELS) {
    const harness = row.candidates?.[label];
    if (!harness || JSON.stringify(harness) === base) continue;
    const { passed, scored } = await confirmHarness(probe, harness, row.cases, confirm);
    lines.push({ attempt: row.attempt, label, passed, scored, containsFix: scored > 0 && passed / scored >= 5 / 6 });
  }
  return lines;
}
