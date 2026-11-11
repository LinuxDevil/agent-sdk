import { ValidationError } from '../../execution/errors';
import { issueMessage } from '../../utils/zodCompat';
import type { HarnessLayer, WorkspaceTree } from '../contracts/baseHarness';
import { harnessProfileSchema, type Harness } from '../contracts/harness';
import { globalProfileParts, workspaceProfilePath } from '../contracts/validateLayers';
import { inlineSchemas, joinPath, normalizeDir, subtree } from '../contracts/validateModel';

/** Reads the harness profile a ref names as a layer whose source is the ref exactly as written. */
export interface ProfileStore {
  /** The profile layer for `ref`; throws a `ValidationError` when the ref is not one this store answers or the profile is missing or invalid. */
  get(ref: string): HarnessLayer;
}

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

export function parsedFiles(files: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(files).map(([path, value]) => [path, path.endsWith('.json') ? jsonOrRaw(value) : value]));
}

function jsonOrRaw(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

export function layerOf(source: string, files: Readonly<Record<string, unknown>>, harness: Harness, where: string): HarnessLayer {
  return { source, harness: inlineSchemas(harness, parsedFiles(files)), texts: textsOf(files, harness, where) };
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

/** Answers `workspace:<path>` refs from `<dir>/<path>/` in the loaded tree. */
export function workspaceProfiles(tree: WorkspaceTree, dir = 'harness-profiles'): ProfileStore {
  const root = normalizeDir(dir);
  return {
    get(ref) {
      const path = workspaceProfilePath(ref);
      if (path === undefined) throw invalid(`'${ref}' is not a workspace profile ref; use 'workspace:<path>'`);
      const folder = joinPath(root, path);
      return profileLayer(ref, subtree(tree, folder), folder);
    },
  };
}

/** Answers `global:<path>@<range>` refs through the injected `resolve`, which returns that profile's folder files keyed relative to the folder. */
export function globalProfiles(resolve: (ref: string) => WorkspaceTree | undefined): ProfileStore {
  return {
    get(ref) {
      if (!globalProfileParts(ref)) throw invalid(`'${ref}' is not a global profile ref with a valid range; use 'global:<path>@<range>' with an exact, ^ or ~ version`);
      const files = resolve(ref);
      if (!files) throw invalid(`global profile '${ref}' was not found in the global store`);
      return profileLayer(ref, files, ref);
    },
  };
}
