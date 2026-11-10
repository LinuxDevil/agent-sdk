import { z } from 'zod';
import { harnessSchema, type Harness } from './harness';

/** The files of a workspace by path relative to its root; each value is parsed JSON or text. */
export type WorkspaceTree = Readonly<Record<string, unknown>>;

/** One harness layer, ready to compose. */
export interface HarnessLayer {
  /** Where the layer came from. */
  source: 'workspace base';
  /** The layer's harness document. */
  harness: Harness;
}

const BASE_HARNESS_DIR = 'harness/';
const BASE_HARNESS_PATH = 'harness/harness.json';

/** Zod schema for the workspace base harness: a `harnessSchema` document with no `id`, `version` or `extends`, always layer 0 under every page; a page overrides a base constraint or criterion by reusing its id, limits take the minimum so a page can only tighten, and hard rules belong in policy, which a page cannot override (R13). */
export const baseHarnessSchema: z.ZodType<Harness> = harnessSchema.superRefine((harness, ctx) => {
  for (const key of ['id', 'version', 'extends'] as const) {
    if (harness[key] !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `a base harness has no '${key}'; the workspace revision versions it and it is always layer 0` });
  }
});

function readDocument(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${BASE_HARNESS_PATH} is not valid JSON`);
  }
}

function formatIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.length > 0 ? `${issue.path.join('.')}: ` : ''}${issue.message}`).join('; ');
}

/** The workspace base harness as layer 0, or `undefined` when the tree has no `harness/` folder; throws when `harness/harness.json` is missing or invalid. */
export function baseHarnessLayer(tree: WorkspaceTree): HarnessLayer | undefined {
  if (!Object.keys(tree).some((path) => path.startsWith(BASE_HARNESS_DIR))) return undefined;
  if (!(BASE_HARNESS_PATH in tree)) throw new Error(`${BASE_HARNESS_PATH} is missing; the harness/ folder needs it`);
  const parsed = baseHarnessSchema.safeParse(readDocument(tree[BASE_HARNESS_PATH]));
  if (!parsed.success) throw new Error(`${BASE_HARNESS_PATH}: ${formatIssues(parsed.error)}`);
  return { source: 'workspace base', harness: parsed.data };
}
