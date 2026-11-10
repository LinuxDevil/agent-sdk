import { z } from 'zod';
import { isSafeRelativePath } from '../../spec/v2/common';
import { harnessSchema, type Harness } from './harness';

/** The files of a workspace by path relative to its root; each value is parsed JSON or text. */
export type WorkspaceTree = Readonly<Record<string, unknown>>;

/** One harness layer, ready to compose. */
export interface HarnessLayer {
  /** A ref naming where the layer came from, such as `workspace base`. */
  source: string;
  /** The layer's harness document. */
  harness: Harness;
  /** The text of each prose file the harness lists, keyed by the path as listed. */
  texts: Record<string, string>;
}

interface BaseHarnessProblem {
  path: string;
  message: string;
}

interface BaseHarnessRead {
  layer?: HarnessLayer;
  problems: BaseHarnessProblem[];
}

const DEFAULT_DIR = 'harness';

/** Zod schema for the workspace base harness: a `harnessSchema` document with no `id`, `version` or `extends`, always layer 0 under every page; a page overrides a base constraint or criterion by reusing its id, limits take the minimum so a page can only tighten, and hard rules belong in policy, which a page cannot override (R13). */
export const baseHarnessSchema: z.ZodType<Harness> = harnessSchema.superRefine((harness, ctx) => {
  for (const key of ['id', 'version', 'extends'] as const) {
    if (harness[key] !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `a base harness has no '${key}'; the workspace revision versions it and it is always layer 0` });
  }
});

function parseText(path: string, raw: unknown): { value?: unknown; problem?: BaseHarnessProblem } {
  if (typeof raw !== 'string') return { value: raw };
  try {
    return { value: JSON.parse(raw) };
  } catch {
    return { problem: { path, message: 'is not valid JSON' } };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeDir(dir: string): string {
  return dir.replace(/^(\.\/)+/, '').replace(/\/+$/, '');
}

function manifestDir(tree: WorkspaceTree): { dir: string; named: boolean; problem?: BaseHarnessProblem } {
  if (!('workspace.json' in tree)) return { dir: DEFAULT_DIR, named: false };
  const { value, problem } = parseText('workspace.json', tree['workspace.json']);
  if (problem) return { dir: DEFAULT_DIR, named: false, problem };
  if (!isRecord(value) || typeof value.harness !== 'string') return { dir: DEFAULT_DIR, named: false };
  const dir = normalizeDir(value.harness);
  if (!isSafeRelativePath(value.harness) || dir.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return { dir: DEFAULT_DIR, named: false, problem: { path: 'workspace.json', message: `harness '${value.harness}' must be a relative folder path inside the workspace` } };
  }
  return { dir, named: true };
}

function issueMessage(issue: z.ZodIssue): string {
  if (/^harness[.[]/.test(issue.message)) return issue.message;
  return `${issue.path.length > 0 ? `${issue.path.join('.')}: ` : ''}${issue.message}`;
}

function readTexts(tree: WorkspaceTree, dir: string, harness: Harness, problems: BaseHarnessProblem[]): Record<string, string> {
  const texts: Record<string, string> = {};
  for (const instruction of harness.instructions ?? []) {
    const path = `${dir}/${normalizeDir(instruction)}`;
    const text = tree[path];
    if (typeof text === 'string') texts[instruction] = text;
    else problems.push({ path, message: 'is listed in instructions but missing from the workspace' });
  }
  return texts;
}

/** Reads the base harness without throwing: the layer when it is valid, and every problem found. */
export function readBaseHarness(tree: WorkspaceTree): BaseHarnessRead {
  const { dir, named, problem } = manifestDir(tree);
  const problems: BaseHarnessProblem[] = problem ? [problem] : [];
  if (!Object.keys(tree).some((path) => path.startsWith(`${dir}/`))) {
    if (named) problems.push({ path: dir, message: 'is named by workspace.json harness but has no files' });
    return { problems };
  }
  const path = `${dir}/harness.json`;
  if (!(path in tree)) return { problems: [...problems, { path, message: 'is missing; the base harness folder needs it' }] };
  const document = parseText(path, tree[path]);
  if (document.problem) return { problems: [...problems, document.problem] };
  const parsed = baseHarnessSchema.safeParse(document.value);
  if (!parsed.success) return { problems: [...problems, ...parsed.error.issues.map((issue) => ({ path, message: issueMessage(issue) }))] };
  const texts = readTexts(tree, dir, parsed.data, problems);
  return problems.length > 0 ? { problems } : { layer: { source: 'workspace base', harness: parsed.data, texts }, problems };
}

/** The workspace base harness as layer 0, or `undefined` when the workspace has no base harness folder; throws one error listing every problem. */
export function baseHarnessLayer(tree: WorkspaceTree): HarnessLayer | undefined {
  const { layer, problems } = readBaseHarness(tree);
  if (problems.length > 0) throw new Error(problems.map((item) => `${item.path}: ${item.message}`).join('\n'));
  return layer;
}
