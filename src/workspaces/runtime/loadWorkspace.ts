import type { WorkspaceTree } from '../contracts/baseHarness';
import { validateWorkspace } from '../contracts/validate';
import type { ValidateWorkspaceOptions, WorkspaceProblem } from '../contracts/validateModel';
import { readSourceTree } from '../source/tree';
import type { RevisionId, WorkspaceSource } from '../source/types';
import { buildManifestView, type WorkspaceManifestView } from './manifestView';
import { WorkspaceValidationError } from './validationError';

/** Options of {@link loadWorkspace}. */
export interface LoadWorkspaceOptions {
  /** The revision to load; defaults to the source's current revision. */
  revision?: RevisionId;
  /** `strict` adds the publish-time checks of `validateWorkspace`. */
  mode: NonNullable<ValidateWorkspaceOptions['mode']>;
}

/** A workspace read from a source at one pinned revision. */
export interface LoadedWorkspace {
  /** The revision every file was read at; later writes to the source do not change this workspace. */
  revision: RevisionId;
  /** The layers, files and inheritance of each page. */
  manifest: WorkspaceManifestView;
  /** Every file's text keyed by workspace-relative path. */
  tree: WorkspaceTree;
  /** The warnings and notes `validateWorkspace` found; an error throws instead. */
  problems: WorkspaceProblem[];
}

/** Reads a whole workspace through `source` at one revision, validates it, and returns it with its manifest; throws `WorkspaceValidationError` when any problem is an error. */
export async function loadWorkspace(source: WorkspaceSource, options: LoadWorkspaceOptions): Promise<LoadedWorkspace> {
  const { revision, tree } = await readSourceTree(source, options.revision === undefined ? {} : { revision: options.revision });
  const problems = validateWorkspace(tree, { mode: options.mode });
  const errors = problems.filter((item) => item.severity === 'error');
  if (errors.length > 0) throw new WorkspaceValidationError(errors);
  return { revision, manifest: buildManifestView(tree), tree, problems };
}
