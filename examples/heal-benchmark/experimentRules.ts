const REPLAYABLE = ['proposal', 'keep-base'];

export function requireModels(values: { model?: string; editor?: string }): { model: string; editor: string } {
  const { model, editor } = values;
  if (!model || !editor) throw new Error('experiment.ts needs --model <id> and --editor <id>.');
  return { model, editor };
}

export function replayable<T extends { attempt: number; outcome?: string }>(rows: readonly T[]): { kept: T[]; skipped: string[] } {
  const kept = rows.filter((row) => row.outcome !== undefined && REPLAYABLE.includes(row.outcome));
  const skipped = rows.filter((row) => !kept.includes(row)).map((row) => `attempt ${row.attempt}: ${row.outcome ?? 'no outcome'}`);
  return { kept, skipped };
}

export function admissionFailure(admitted: readonly { caseId: string; passed: number; scored: number }[], runs: number): string | undefined {
  if (admitted.length === 0) return 'The arms run needs at least one --holdout case.';
  const failed = admitted.find(({ passed }) => passed < runs);
  if (!failed) return undefined;
  return `Held-out case ${failed.caseId} passed ${failed.passed}/${failed.scored} on the base, below ${runs}/${runs}, so the arms run will not start. Run --admit and choose admitted cases.`;
}
