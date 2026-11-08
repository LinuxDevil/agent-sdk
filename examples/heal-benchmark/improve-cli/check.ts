import type { CaseCheck } from 'lousho/improve';
import { latestProjectRun } from './projectRuns.ts';

const check: CaseCheck = (input) => {
  const run = latestProjectRun();
  if (!run || run.simulated || run.input !== input.trim()) return null;
  const task = run.project.tasks.find((candidate) => candidate.input === run.input);
  if (!task) return null;
  if (!task.failure) return task.check('');
  const failure = task.failure();
  return failure === undefined ? true : { passed: false, failure };
};

export default check;
