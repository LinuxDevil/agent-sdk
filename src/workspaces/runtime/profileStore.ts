import { ValidationError } from '../../execution/errors';
import { issueMessage } from '../../utils/zodCompat';
import type { HarnessLayer, WorkspaceTree } from '../contracts/baseHarness';
import { harnessProfileSchema, type Harness } from '../contracts/harness';
import { inlineSchemas, joinPath, normalizeDir, subtree } from '../contracts/validateModel';
import { isVersionRange } from '../contracts/versionRange';

/** Reads the harness profile a ref names as a layer whose source is the ref exactly as written. */
export interface ProfileStore {
  /** The profile layer for `ref`; throws a `ValidationError` when the ref is not one this store answers or the profile is missing or invalid. */
  get(ref: string): HarnessLayer;
}

const SEGMENT = '[a-z0-9][a-z0-9-]*';
const PATH = `${SEGMENT}(?:/${SEGMENT})*`;
const WORKSPACE_REF = new RegExp(`^(?:workspace:)?(${PATH})$`);
const GLOBAL_REF = new RegExp(`^global:(${PATH})@(.+)$`);

export function invalid(message: string): ValidationError {
  return new ValidationError(message, undefined, 'LOUSHO_SPEC_INVALID');
}

export function jsonOf(value: unknown, where: string): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    throw invalid(`${where} is not valid JSON`);
  }
}

function textsOf(files: Readonly<Record<string, unknown>>, harness: Harness, where: string): Record<string, string> {
  const texts: Record<string, string> = {};
  for (const file of harness.instructions ?? []) {
    const text = files[joinPath('', file)];
    if (typeof text !== 'string') throw invalid(`${where} lists instruction '${file}', which is missing`);
    texts[file] = text;
  }
  return texts;
}

export function layerOf(source: string, files: Readonly<Record<string, unknown>>, harness: Harness, where: string): HarnessLayer {
  return { source, harness: inlineSchemas(harness, files), texts: textsOf(files, harness, where) };
}

function profileLayer(ref: string, files: Readonly<Record<string, unknown>>, where: string): HarnessLayer {
  if (!('harness.json' in files)) throw invalid(`profile '${ref}' has no harness.json at ${where}`);
  const parsed = harnessProfileSchema.safeParse(jsonOf(files['harness.json'], `${where}/harness.json`));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issueMessage(issue)}`);
    throw invalid(`profile '${ref}' is invalid: ${issues.join('; ')}`);
  }
  return layerOf(ref, files, parsed.data, `profile '${ref}'`);
}

/** Answers `workspace:<path>` and unprefixed `<path>` refs from `<dir>/<path>/` in the loaded tree. */
export function workspaceProfiles(tree: WorkspaceTree, dir = 'harness-profiles'): ProfileStore {
  const root = normalizeDir(dir);
  return {
    get(ref) {
      const match = WORKSPACE_REF.exec(ref);
      if (!match) throw invalid(`'${ref}' is not a workspace profile ref; use '<path>' or 'workspace:<path>'`);
      const folder = joinPath(root, match[1]);
      return profileLayer(ref, subtree(tree, folder), folder);
    },
  };
}

/** Answers `global:<path>@<range>` refs through the injected `resolve`, which returns that profile's folder files keyed relative to the folder. */
export function globalProfiles(resolve: (ref: string) => WorkspaceTree | undefined): ProfileStore {
  return {
    get(ref) {
      const match = GLOBAL_REF.exec(ref);
      if (!match) throw invalid(`'${ref}' is not a global profile ref; use 'global:<path>@<range>'`);
      if (!isVersionRange(match[2])) throw invalid(`'${ref}' has an invalid version range '${match[2]}'`);
      const files = resolve(ref);
      if (!files) throw invalid(`global profile '${ref}' was not found in the global store`);
      return profileLayer(ref, files, ref);
    },
  };
}
