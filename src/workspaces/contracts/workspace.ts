import { z } from 'zod';
import { modelIdSchema } from '../../spec/v2/common';
import { KEBAB_CASE, workspacePathSchema } from './common';

const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;

/** Per-run limits a workspace sets for its pages. */
export interface WorkspaceLimits {
  /** Most pages one workspace run may execute at once (default 3); a main-agent harness can only tighten it. */
  maxConcurrentPages?: number;
  /** Spend cap in US dollars for one workspace run. */
  maxCostUsdPerRun?: number;
}

/** The `workspace.json` manifest (`lousho.workspace/1`): what a workspace is made of. */
export interface WorkspaceManifest {
  /** Schema id; always `lousho.workspace/1`. */
  schema: 'lousho.workspace/1';
  /** Workspace id, kebab-case. */
  id: string;
  /** Display name. */
  name: string;
  /** Workspace version, semver. */
  version: string;
  /** What the workspace is for. */
  description: string;
  /** Business domain label, for example `marketing`. */
  domain?: string;
  /** The main agent that routes work to pages, or `null` to run pages directly. */
  mainAgent: {
    /** The main agent's folder; always `./main-agent`. */
    dir: './main-agent';
    /** Whether the main agent also gets the shared context (policy always applies). */
    inheritsShared?: boolean;
    /** The main-agent harness folder; when absent, `./main-agent/harness/` is used if that folder exists. */
    harness?: string;
  } | null;
  /** The base harness folder; when absent, `./harness/` is used if that folder exists. */
  harness?: string;
  /** Page folder names under `pages/`, in display order; every page folder must be listed. */
  pages: string[];
  /** Workspace agents folder (default `./agents`). */
  agents?: string;
  /** Workspace harness profiles folder. */
  harnessProfiles?: string;
  /** Workspace workflows folder. */
  workflows?: string;
  /** Version ranges for referenced global agents and harness profiles, keyed by ref. */
  dependencies?: {
    /** Agent ref to version range. */
    agents?: Record<string, string>;
    /** Harness profile ref to version range. */
    profiles?: Record<string, string>;
  };
  /** Defaults that pages inherit. */
  defaults?: {
    /** Default model, as `provider/model`. */
    model?: string;
    /** Per-run limits. */
    limits?: WorkspaceLimits;
  };
  /** How the run budget is split. */
  budget?: {
    /** `shared` pools one budget across pages; `per-page` gives each page its own share. */
    mode: 'shared' | 'per-page';
  };
  /** Self-improvement settings. */
  improve?: {
    /** Whether pages are improvable by default (default `true`); an improvable page needs an executable criterion. */
    enabled?: boolean;
    /** One healer for the workspace (`shared`) or one per page (`per-page`). */
    healer?: 'shared' | 'per-page';
    /** Model the proposer uses, as `provider/model`, separate from any page's model. */
    proposerModel?: string;
  };
}

const nonEmpty = z.string().min(1, 'must not be empty');

const rangeMapSchema = z.record(nonEmpty, nonEmpty);

const pageNameSchema = z
  .string()
  .regex(KEBAB_CASE, "must be a page folder name under pages/: kebab-case, no path separators");

const pagesSchema = z.array(pageNameSchema).superRefine((pages, ctx) => {
  const seen = new Set<string>();
  pages.forEach((page, index) => {
    if (seen.has(page)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate page '${page}'`, path: [index] });
    seen.add(page);
  });
});

const limitsSchema = z
  .object({
    maxConcurrentPages: z.number().int().positive().optional(),
    maxCostUsdPerRun: z.number().positive().optional(),
  })
  .strict();

export const workspaceManifestObjectSchema = z
  .object({
    schema: z.literal('lousho.workspace/1'),
    id: z.string().regex(KEBAB_CASE, 'must be kebab-case'),
    name: nonEmpty,
    version: z.string().regex(SEMVER, 'must be a semver version, e.g. 1.0.0'),
    description: nonEmpty,
    domain: nonEmpty.optional(),
    mainAgent: z
      .object({
        dir: z.literal('./main-agent'),
        inheritsShared: z.boolean().optional(),
        harness: workspacePathSchema.optional(),
      })
      .strict()
      .nullable(),
    harness: workspacePathSchema.optional(),
    pages: pagesSchema,
    agents: workspacePathSchema.optional(),
    harnessProfiles: workspacePathSchema.optional(),
    workflows: workspacePathSchema.optional(),
    dependencies: z
      .object({ agents: rangeMapSchema.optional(), profiles: rangeMapSchema.optional() })
      .strict()
      .optional(),
    defaults: z
      .object({ model: modelIdSchema.optional(), limits: limitsSchema.optional() })
      .strict()
      .optional(),
    budget: z
      .object({ mode: z.enum(['shared', 'per-page']) })
      .strict()
      .optional(),
    improve: z
      .object({
        enabled: z.boolean().optional(),
        healer: z.enum(['shared', 'per-page']).optional(),
        proposerModel: modelIdSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** Zod schema for `workspace.json` (`lousho.workspace/1`); every object is strict, so an unknown key is an error. */
export const workspaceManifestSchema: z.ZodType<WorkspaceManifest> = workspaceManifestObjectSchema;
