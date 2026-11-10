import { z } from 'zod';
import { modelIdSchema } from '../../spec/v2/common';
import { KEBAB_CASE, workspacePathSchema } from './common';

/** The four execution types a page can run under. */
export type WorkType = 'single' | 'multi-agent' | 'workflow' | 'goal-oriented';

/** Every {@link WorkType}, in display order. */
export const WORK_TYPES: readonly WorkType[] = ['single', 'multi-agent', 'workflow', 'goal-oriented'];

const NESTED_PAGES_MESSAGE = 'nested pages are not supported in v1';

function isNestedPagesPath(path: string): boolean {
  return path.replace(/^\.\//, '').split('/')[0] === 'pages';
}

/** Returns the page-relative paths whose first segment is `pages` (nested pages are not supported in v1). */
export function findNestedPages(relativePaths: readonly string[]): string[] {
  return relativePaths.filter(isNestedPagesPath);
}

/** Per-run limits for one page's execution. */
export interface PageExecutionLimits {
  /** Wall-clock cap in milliseconds for one run. */
  maxDurationMs?: number;
  /** Most model turns one run may take. */
  maxTurns?: number;
  /** Spend cap in US dollars for one run. */
  maxCostUsd?: number;
}

/** The `execution` block of `page.json`: the active type plus one config block per type. */
export interface PageExecution {
  /** The active execution type; its config block is required, the other blocks are validated but not run. */
  type: WorkType;
  /** Config for `single`. */
  single?: {
    /** Agent alias from `agents.json`. */
    agent: string;
  };
  /** Config for `multi-agent`. */
  multiAgent?: {
    /** Lead agent alias. */
    lead: string;
    /** Delegate agent aliases the lead can hand work to. */
    delegates?: string[];
  };
  /** Config for `workflow`. */
  workflow?: {
    /** `./workflow.json` or a `workspace:<name>` workflow ref. */
    workflow: string;
  };
  /** Config for `goal-oriented`. */
  goal?: {
    /** Lead agent alias. */
    lead: string;
    /** Delegate agent aliases the lead can hand work to. */
    delegates?: string[];
    /** The goal definition file; always `./goal.json`. */
    goal: './goal.json';
  };
  /** Limits shared by every type. */
  limits?: PageExecutionLimits;
  /** What to do when a run fails (default `return-to-main`). */
  onFailure?: 'return-to-main' | 'stop' | 'ask';
  /** Whether the run saves checkpoints. */
  checkpoint?: boolean;
}

/** The `page.json` manifest (`lousho.page/1`): one task environment inside a workspace. */
export interface PageManifest {
  /** Schema id; always `lousho.page/1`. */
  schema: 'lousho.page/1';
  /** Page id, kebab-case. */
  id: string;
  /** Display name. */
  name: string;
  /** What the page does; the main agent routes on it. */
  description: string;
  /** Business domain label, for example `marketing`. */
  domain?: string;
  /** How the page performs its task. */
  harness: {
    /** Harness profile refs this page extends. */
    extends: string[];
    /** The page harness folder (default `./harness/`). */
    overrides?: string;
  };
  /** The page's agents file (default `./agents.json`). */
  agents?: string;
  /** How the page runs. */
  execution: PageExecution;
  /** Self-improvement override for this page. */
  improve?: {
    /** Whether this page is improvable; overrides the workspace default. */
    enabled?: boolean;
  };
  /** Platform bindings. */
  platform?: {
    /** Platform profile name. */
    profile?: string;
    /** Platform adapter name. */
    adapter?: string;
  };
  /** The page UI file (default `./ui/page.ui.json`). */
  ui?: string;
  /** Defaults for this page. */
  defaults?: {
    /** Default model, as `provider/model`. */
    model?: string;
  };
  /** Reserved: only `{ kind: 'local' }` is accepted. */
  runtime?: {
    /** Always `local` in v1. */
    kind: 'local';
  };
}

const nonEmpty = z.string().min(1, 'must not be empty');

const REF_PREFIX = /^(?:workspace|local|global):/;

const agentAliasSchema = nonEmpty.refine((value) => !REF_PREFIX.test(value), 'must be an agent alias from agents.json, not a ref');

const pagePathSchema = workspacePathSchema.refine((value) => !isNestedPagesPath(value), NESTED_PAGES_MESSAGE);

const limitsSchema = z
  .object({
    maxDurationMs: z.number().int().positive().optional(),
    maxTurns: z.number().int().positive().optional(),
    maxCostUsd: z.number().positive().optional(),
  })
  .strict();

const workflowRefSchema = z.union([z.literal('./workflow.json'), z.string().regex(/^workspace:[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)]);

const BLOCK_OF: Record<WorkType, 'single' | 'multiAgent' | 'workflow' | 'goal'> = {
  single: 'single',
  'multi-agent': 'multiAgent',
  workflow: 'workflow',
  'goal-oriented': 'goal',
};

const executionSchema = z
  .object({
    type: z.enum(['single', 'multi-agent', 'workflow', 'goal-oriented']),
    single: z.object({ agent: agentAliasSchema }).strict().optional(),
    multiAgent: z.object({ lead: agentAliasSchema, delegates: z.array(agentAliasSchema).optional() }).strict().optional(),
    workflow: z.object({ workflow: workflowRefSchema }).strict().optional(),
    goal: z.object({ lead: agentAliasSchema, delegates: z.array(agentAliasSchema).optional(), goal: z.literal('./goal.json') }).strict().optional(),
    limits: limitsSchema.optional(),
    onFailure: z.enum(['return-to-main', 'stop', 'ask']).optional(),
    checkpoint: z.boolean().optional(),
  })
  .strict()
  .superRefine((execution, ctx) => {
    const block = BLOCK_OF[execution.type];
    if (execution[block] === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `execution type '${execution.type}' requires its '${block}' block`, path: [block] });
    }
  });

export const pageObjectSchema = z
  .object({
    schema: z.literal('lousho.page/1'),
    id: z.string().regex(KEBAB_CASE, 'must be kebab-case'),
    name: nonEmpty,
    description: nonEmpty,
    domain: nonEmpty.optional(),
    harness: z.object({ extends: z.array(nonEmpty), overrides: pagePathSchema.optional() }).strict(),
    agents: pagePathSchema.optional(),
    execution: executionSchema,
    improve: z.object({ enabled: z.boolean().optional() }).strict().optional(),
    platform: z.object({ profile: nonEmpty.optional(), adapter: nonEmpty.optional() }).strict().optional(),
    ui: pagePathSchema.optional(),
    defaults: z.object({ model: modelIdSchema.optional() }).strict().optional(),
    runtime: z
      .object({ kind: z.custom<'local'>((value) => value === 'local', { message: "only 'local' is accepted; other runtime kinds are reserved" }) })
      .strict()
      .optional(),
  })
  .strict();

/** Zod schema for `page.json` (`lousho.page/1`); every object is strict, so an unknown key is an error. */
export const pageSchema: z.ZodType<PageManifest> = pageObjectSchema;
