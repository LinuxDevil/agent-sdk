import { z } from 'zod';
import type { WorkspaceManifest } from './workspace';
import { workspacePathSchema } from './common';

const DEFAULT_MAX_CONCURRENT_PAGES = 3;

const SECURITY_KEYS: ReadonlySet<string> = new Set([
  'permissions',
  'tools',
  'secrets',
  'sandbox',
  'approvals',
  'mcpServers',
  'hooks',
  'model',
  'provider',
  'network',
]);

const EXECUTION_KEYS: ReadonlySet<string> = new Set(['execution', 'workflow', 'goal', 'steps', 'lead', 'delegates']);

/** A page the main agent may route to, and when. */
export interface MainHarnessRoute {
  /** Page folder name under `pages/`; checked against `workspace.json` by `validateWorkspace`, not here. */
  page: string;
  /** Prose condition for routing to the page. */
  when: string;
}

/** The main agent's clarifying-question policy. */
export interface MainHarnessClarify {
  /** Situations where the main agent asks before running. */
  askWhen: string[];
  /** Situations where the main agent runs without asking. */
  runImmediatelyWhen: string[];
}

/** Prose guidance for how the main agent presents results. */
export interface MainHarnessPresentation {
  /** How results are presented. */
  style: string;
  /** How follow-up suggestions are offered. */
  followUps: string;
  /** How revision requests are handled. */
  revisions: string;
}

/** Limits a main harness may set; they can only tighten `workspace.json`. */
export interface MainHarnessLimits {
  /** Most pages run at once; values above the workspace's are clamped. */
  maxConcurrentPages?: number;
}

/** What the main agent does when a routed page fails. */
export type MainHarnessPageFailure = 'report' | 'retry-once' | 'ask';

/** The main-agent harness (`lousho.main-harness/1`): how the main agent routes, clarifies and presents. */
export interface MainHarness {
  /** Schema id; always `lousho.main-harness/1`. */
  schema: 'lousho.main-harness/1';
  /** Prose files in `main-agent/harness/`, relative paths. */
  instructions?: string[];
  /** Pages the main agent may route to; absent means every page, routed on its description. */
  routes?: MainHarnessRoute[];
  /** When to ask and when to run immediately. */
  clarify?: MainHarnessClarify;
  /** Presentation guidance. */
  presentation?: MainHarnessPresentation;
  /** Limits that can only tighten the workspace's. */
  limits?: MainHarnessLimits;
  /** Behaviour when a routed page fails. */
  onPageFailure?: MainHarnessPageFailure;
}

/** One row of the main-harness optionality table. */
export interface MainHarnessOptionalityRow {
  /** The workspace situation. */
  situation: 'No main agent' | 'Main agent, no main harness' | 'Main agent and main harness';
  /** What the runtime does in that situation. */
  behaviour: string;
}

/** Optionality of the main agent and its harness, for prompt assembly and the docs. */
export const MAIN_HARNESS_OPTIONALITY: readonly MainHarnessOptionalityRow[] = [
  { situation: 'No main agent', behaviour: 'No main harness. Works for any number of pages.' },
  { situation: 'Main agent, no main harness', behaviour: 'Default routing prompt built from the page descriptions' },
  { situation: 'Main agent and main harness', behaviour: 'The harness drives routing, presentation and follow-ups' },
];

/** Result of cross-checking a main harness against its workspace manifest. */
export interface MainHarnessCrossCheck {
  /** Problems that make the workspace invalid. */
  errors: string[];
  /** Problems the runtime corrects, such as a clamped limit. */
  warnings: string[];
}

const nonEmpty = z.string().min(1, 'must not be empty');

function scan(value: unknown, path: string, out: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scan(item, `${path}[${index}]`, out));
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (SECURITY_KEYS.has(key)) out.push(`${childPath}: harnesses describe the task; the runtime enforces ${key} (R13)`);
    else if (EXECUTION_KEYS.has(key)) out.push(`${childPath}: a harness says what, not how; execution lives in page.json (R18)`);
    scan(child, childPath, out);
  }
}

/** Finds R13 and R18 forbidden keys at any depth of an unparsed main harness. */
export function findForbiddenMainHarnessKeys(raw: unknown): string[] {
  const out: string[] = [];
  scan(raw, 'harness', out);
  return out;
}

export const mainHarnessObjectSchema = z
  .object({
    schema: z.literal('lousho.main-harness/1'),
    instructions: z.array(workspacePathSchema).optional(),
    routes: z.array(z.object({ page: nonEmpty, when: nonEmpty }).strict()).optional(),
    clarify: z.object({ askWhen: z.array(nonEmpty), runImmediatelyWhen: z.array(nonEmpty) }).strict().optional(),
    presentation: z.object({ style: nonEmpty, followUps: nonEmpty, revisions: nonEmpty }).strict().optional(),
    limits: z.object({ maxConcurrentPages: z.number().int().positive().optional() }).strict().optional(),
    onPageFailure: z.enum(['report', 'retry-once', 'ask']).optional(),
  })
  .strict();

/** Zod schema for the main-agent harness (`lousho.main-harness/1`); forbidden R13 and R18 keys are errors at any depth. */
export const mainHarnessSchema: z.ZodType<MainHarness> = z
  .any()
  .superRefine((raw, ctx) => {
    for (const message of findForbiddenMainHarnessKeys(raw)) ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  })
  .pipe(mainHarnessObjectSchema);

/** Cross-checks a parsed main harness against the parsed workspace manifest; route page ids are left to `validateWorkspace`. */
export function crossCheckMainHarness(harness: MainHarness, manifest: WorkspaceManifest): MainHarnessCrossCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (manifest.mainAgent === null) errors.push('a main harness needs a main agent, but workspace.json sets mainAgent to null');
  const requested = harness.limits?.maxConcurrentPages;
  const allowed = manifest.defaults?.limits?.maxConcurrentPages ?? DEFAULT_MAX_CONCURRENT_PAGES;
  if (requested !== undefined && requested > allowed) {
    warnings.push(`limits.maxConcurrentPages ${requested} is above the workspace's ${allowed}; it is clamped to ${allowed}`);
  }
  return { errors, warnings };
}
