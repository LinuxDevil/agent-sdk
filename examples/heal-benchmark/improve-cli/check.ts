import type { CaseCheck } from 'lousho/improve';
import { latestProjectRun } from './projectRuns.ts';

const check: CaseCheck = (input) => {
  const run = latestProjectRun();
  if (!run || run.simulated || run.input !== input.trim()) return null;
  const task = run.project.tasks.find((candidate) => candidate.input === run.input);
  return task ? task.check('') : null;
};

export default check;
