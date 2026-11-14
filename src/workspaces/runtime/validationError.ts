import { SDKError } from '../../utils/sdkError';
import { brandClass } from '../../utils/brand';
import type { WorkspaceProblem } from '../contracts/validateModel';

/** A workspace that failed validation on load (`LOUSHO_WORKSPACE_INVALID`); `problems` holds every error `validateWorkspace` found. */
export class WorkspaceValidationError extends SDKError {
  /** The error-severity problems, in `validateWorkspace` order. */
  readonly problems: readonly WorkspaceProblem[];

  constructor(problems: readonly WorkspaceProblem[]) {
    const lines = problems.map((item) => `${item.code} ${item.file}${item.path === '' ? '' : `#${item.path}`} ${item.message}`);
    super(`The workspace is not valid (${problems.length} ${problems.length === 1 ? 'error' : 'errors'}):\n${lines.join('\n')}`, 'LOUSHO_WORKSPACE_INVALID');
    this.name = 'WorkspaceValidationError';
    this.problems = problems;
  }
}
brandClass(WorkspaceValidationError, 'WorkspaceValidationError');
