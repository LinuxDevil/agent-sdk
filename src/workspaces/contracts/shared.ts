import { z } from 'zod';
import { isSafeRelativePath } from '../../spec/v2/common';

/** The folders under a workspace's `shared/`. */
export const SHARED_FOLDERS = ['instructions', 'knowledge', 'brand', 'resources', 'skills', 'memory', 'policies'] as const;

/** One folder name under `shared/`. */
export type SharedFolder = (typeof SHARED_FOLDERS)[number];

/** The only file that may declare the workspace policy. */
export const SHARED_POLICY_FILE = 'shared/policies/policy.json';

/** The shared folders whose files other files may reference as `shared:<path>`. */
export const REFERENCEABLE_SHARED_FOLDERS = ['knowledge', 'brand', 'resources'] as const;

/** Where files of each shared folder must sit, as workspace-relative path patterns. */
export const SHARED_PATH_PATTERNS: Readonly<Record<SharedFolder, RegExp>> = {
  instructions: /^shared\/instructions\/[^/]+\.md$/,
  knowledge: /^shared\/knowledge\/.+$/,
  brand: /^shared\/brand\/.+$/,
  resources: /^shared\/resources\/.+$/,
  skills: /^shared\/skills\/[a-z][a-z0-9]*(?:-[a-z0-9]+)*\/SKILL\.md$/,
  memory: /^shared\/memory\/[^/]+\.ts$/,
  policies: /^shared\/policies\/policy\.json$/,
};

const REFERENCE_PREFIX = 'shared:';

function isSharedReference(value: string): boolean {
  if (!value.startsWith(REFERENCE_PREFIX)) return false;
  const path = value.slice(REFERENCE_PREFIX.length);
  if (!isSafeRelativePath(path) || path.split('/').some((segment) => segment === '.' || segment === '..' || segment === '')) return false;
  const folder = path.split('/')[0] as (typeof REFERENCEABLE_SHARED_FOLDERS)[number];
  return path.includes('/') && REFERENCEABLE_SHARED_FOLDERS.includes(folder);
}

/** Zod schema for a `shared:<path>` reference to a file under `shared/knowledge`, `shared/brand` or `shared/resources`. */
export const sharedReferenceSchema = z
  .string()
  .refine(isSharedReference, 'must be shared:<folder>/<path> with <folder> one of knowledge, brand or resources, and a path that stays inside shared/');

/** Orders instruction files by file name (plain code-unit order, so it is the same on every machine); paths outside `shared/instructions/*.md` are dropped. */
export function orderInstructionFiles(paths: readonly string[]): string[] {
  const name = (path: string) => path.slice(path.lastIndexOf('/') + 1);
  return paths
    .filter((path) => SHARED_PATH_PATTERNS.instructions.test(path))
    .sort((a, b) => (name(a) < name(b) ? -1 : name(a) > name(b) ? 1 : 0));
}

/** One row of {@link INHERITANCE_RULES}. */
export interface InheritanceRule {
  /** What is inherited. */
  item: 'instructions' | 'skills' | 'memory' | 'context files' | 'policies' | 'main agent';
  /** How it combines with the layers below it. */
  rule: string;
  /** The shared folders this row governs. */
  folders: readonly SharedFolder[];
}

/** How each shared folder reaches pages and the main agent; read by the composer (P1.4) and the docs. */
export const INHERITANCE_RULES: readonly InheritanceRule[] = [
  { item: 'instructions', rule: 'Shared first, then harness, then the agent', folders: ['instructions'] },
  { item: 'skills', rule: 'Union; a clash is an error unless `override: true`', folders: ['skills'] },
  { item: 'memory', rule: 'Shared slots are shared instances, page slots are private', folders: ['memory'] },
  { item: 'context files', rule: 'Referenced as `shared:<path>`; never merged into a prompt on their own', folders: ['knowledge', 'brand', 'resources'] },
  { item: 'policies', rule: "Apply to every page and to the main agent, and can't be opted out of", folders: ['policies'] },
  { item: 'main agent', rule: 'Gets shared *context* only if `inheritsShared` (A2), but always gets shared *policy*', folders: [] },
];
