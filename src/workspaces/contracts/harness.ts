import { z } from 'zod';
import { isSafeRelativePath } from '../../spec/v2/common';
import { isRawJsonSchema } from '../../utils/zodCompat';
import { KEBAB_CASE, SEMVER, workspacePathSchema } from './common';
import { harnessKeyErrors } from './forbiddenKeys';

/** A `harness.json` document (`lousho.harness/1`): how a page performs its task, never security or the execution process (R13, R18). */
export interface Harness {
  /** Schema id; always `lousho.harness/1`. */
  schema: 'lousho.harness/1';
  /** Profile id, kebab-case; required for profiles. */
  id?: string;
  /** Profile version, semver; required for profiles. */
  version?: string;
  /** Profile refs this harness extends, composed in order. */
  extends?: string[];
  /** Prose `.md` files, relative to the harness folder. */
  instructions?: string[];
  /** Who the output is for. */
  audience?: {
    /** The audience in prose. */
    description: string;
    /** Named traits of the audience, as free text. */
    traits?: Record<string, string>;
  };
  /** Where the output is published. */
  platform?: {
    /** Platform id, for example `instagram`. */
    id: string;
    /** The platform's requirements, as free-form data. */
    requirements?: Record<string, unknown>;
  };
  /** The page's input. */
  inputs?: {
    /** A JSON Schema object with `type: 'object'`, or a relative path to one. */
    schema: Record<string, unknown> | string;
  };
  /** The page's output. */
  outputs?: {
    /** A JSON Schema object, or a relative path to one. */
    schema?: Record<string, unknown> | string;
    /** Files the page produces. */
    artifacts?: {
      /** Artifact name, unique in the harness. */
      name: string;
      /** Media type, for example `image/png`. */
      mediaType: string;
      /** Whether a run must produce it. */
      required?: boolean;
    }[];
  };
  /** What the page needs from the runtime. */
  capabilities?: {
    /** Dotted capability names the runtime must provide; requirements, never grants. */
    require?: string[];
  };
  /** Rules the output must follow, each overridable by id. */
  constraints?: {
    /** Constraint id, kebab-case, unique in the harness. */
    id: string;
    /** The rule in prose. */
    text: string;
  }[];
  /** How the output is judged. */
  evaluation?: {
    /** The criteria; each has an executable `check`, a `rubric`, or both. */
    criteria: {
      /** Criterion id, kebab-case, unique in the harness. */
      id: string;
      /** What the criterion checks. */
      description: string;
      /** An executable check, the form R19 requires. */
      check?: string;
      /** A rubric for a judge; never gates an edit on its own. */
      rubric?: string;
      /** Relative weight in the score. */
      weight?: number;
    }[];
    /** Pass mark for the weighted score, from 0 to 1. */
    threshold?: number;
  };
  /** Runtime limits and hints. */
  runtime?: {
    /** Per-run limits. */
    limits?: {
      /** Longest a run may take, in milliseconds. */
      maxDurationMs?: number;
      /** Most model turns a run may take. */
      maxTurns?: number;
      /** Spend cap in US dollars for one run. */
      maxCostUsd?: number;
    };
    /** Provider-agnostic model hints. */
    modelHints?: {
      /** Sampling temperature, from 0 to 2. */
      temperature?: number;
      /** Reasoning effort. */
      reasoning?: 'none' | 'minimal' | 'low' | 'medium' | 'high';
    };
  };
  /** Extra context for the page. */
  context?: {
    /** Relative paths of resources to load. */
    resources?: string[];
  };
}

/** A harness profile: a harness with a required `id` and `version`. */
export interface HarnessProfile extends Harness {
  /** Profile id, kebab-case. */
  id: string;
  /** Profile version, semver. */
  version: string;
}

const nonEmpty = z.string().min(1, 'must not be empty');
const kebabId = z.string().regex(KEBAB_CASE, 'must be kebab-case');
const positive = z.number().positive();
const positiveInt = z.number().int().positive();
const CAPABILITY = /^[A-Za-z][\w-]*(?:\.[A-Za-z][\w-]*)*$/;

function isObjectSchema(value: unknown): boolean {
  return isRawJsonSchema(value) && value.type === 'object';
}

const inputSchemaRef = z.custom<Record<string, unknown> | string>(
  (value) => (typeof value === 'string' ? isSafeRelativePath(value) : isObjectSchema(value)),
  "must be a JSON Schema object with type 'object', or a relative path to one inside the workspace"
);

const outputSchemaRef = z.custom<Record<string, unknown> | string>(
  (value) => (typeof value === 'string' ? isSafeRelativePath(value) : isRawJsonSchema(value)),
  'must be a JSON Schema object, or a relative path to one inside the workspace'
);

function uniqueBy<K extends string, T extends Record<K, string>>(field: K) {
  return (items: T[], ctx: z.RefinementCtx): void => {
    const seen = new Set<string>();
    items.forEach((item, index) => {
      const value = item[field];
      if (seen.has(value)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate '${value}'`, path: [index, field] });
      seen.add(value);
    });
  };
}

const criterionSchema = z
  .object({
    id: kebabId,
    description: nonEmpty,
    check: nonEmpty.optional(),
    rubric: nonEmpty.optional(),
    weight: positive.optional(),
  })
  .strict()
  .refine((criterion) => criterion.check !== undefined || criterion.rubric !== undefined, 'a criterion needs a check, a rubric, or both');

export const harnessObjectSchema = z
  .object({
    schema: z.literal('lousho.harness/1'),
    id: kebabId.optional(),
    version: z.string().regex(SEMVER, 'must be a semver version, e.g. 1.0.0').optional(),
    extends: z.array(nonEmpty).optional(),
    instructions: z.array(workspacePathSchema.refine((path) => path.endsWith('.md'), 'must be a .md file')).optional(),
    audience: z.object({ description: nonEmpty, traits: z.record(z.string(), z.string()).optional() }).strict().optional(),
    platform: z.object({ id: nonEmpty, requirements: z.record(z.string(), z.unknown()).optional() }).strict().optional(),
    inputs: z.object({ schema: inputSchemaRef }).strict().optional(),
    outputs: z
      .object({
        schema: outputSchemaRef.optional(),
        artifacts: z
          .array(z.object({ name: nonEmpty, mediaType: nonEmpty, required: z.boolean().optional() }).strict())
          .superRefine(uniqueBy('name'))
          .optional(),
      })
      .strict()
      .optional(),
    capabilities: z
      .object({ require: z.array(z.string().regex(CAPABILITY, 'must be a dotted capability name, e.g. image.generate')).optional() })
      .strict()
      .optional(),
    constraints: z
      .array(z.object({ id: kebabId, text: nonEmpty }).strict())
      .superRefine(uniqueBy('id'))
      .optional(),
    evaluation: z
      .object({ criteria: z.array(criterionSchema).superRefine(uniqueBy('id')), threshold: z.number().min(0).max(1).optional() })
      .strict()
      .optional(),
    runtime: z
      .object({
        limits: z
          .object({ maxDurationMs: positiveInt.optional(), maxTurns: positiveInt.optional(), maxCostUsd: positive.optional() })
          .strict()
          .optional(),
        modelHints: z
          .object({
            temperature: z.number().min(0).max(2).optional(),
            reasoning: z.enum(['none', 'minimal', 'low', 'medium', 'high']).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    context: z
      .object({ resources: z.array(workspacePathSchema).optional() })
      .strict()
      .optional(),
  })
  .strict();

export const harnessProfileObjectSchema = harnessObjectSchema.extend({
  id: kebabId,
  version: z.string().regex(SEMVER, 'must be a semver version, e.g. 1.0.0'),
});

function rejectForbiddenKeys(value: unknown, ctx: z.RefinementCtx): void {
  for (const error of harnessKeyErrors(value)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: error.message, path: error.path });
}

/** Zod schema for `harness.json` (`lousho.harness/1`) as used by a page or the base harness; a forbidden key anywhere is an R13 or R18 error, and every object is strict. */
export const harnessSchema: z.ZodType<Harness> = z.any().superRefine(rejectForbiddenKeys).pipe(harnessObjectSchema);

/** Zod schema for a harness profile: `harnessSchema` with `id` and `version` required. */
export const harnessProfileSchema: z.ZodType<HarnessProfile> = z.any().superRefine(rejectForbiddenKeys).pipe(harnessProfileObjectSchema);

/** Whether the harness has at least one criterion with an executable `check` (R19). */
export function hasExecutableCriterion(harness: Harness): boolean {
  return harness.evaluation?.criteria.some((criterion) => criterion.check !== undefined) ?? false;
}
