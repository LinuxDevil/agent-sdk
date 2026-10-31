/**
 * The `spec.memory` section of AgentSpec v2: each entry names a memory slot
 * (`remember_<name>` / `recall_<name>` / `forget_<name>` tools plus recall at
 * run start) whose scope and provider are plain data. `resolve/memory.ts`
 * compiles an entry to the `defineMemory()` slot `createAgent({ memory })`
 * takes; `recall`, `expose`, `itemJsonSchema` and `itemKey` use the same
 * names as `DefineMemoryOptions`, so the defineMemory docs apply unchanged.
 * Browser-safe: no `node:*` imports - the providers live in `resolve/`.
 */
import { z } from 'zod';
import { typeErrors } from '../../utils/zodCompat';
import { relativePathSchema } from './common';

/** The slot name rule of `defineMemory`: the memory tools are `remember_<name>` etc. */
const SLOT_NAME = /^[a-zA-Z0-9_-]{1,55}$/;

const maxItems = z.number().int().positive('must be a positive integer');

/** Whose memory a run sees, as data: one shared memory, one per session, or one per `metadata[key]` value. */
export type MemoryScopeSpec = 'global' | 'session' | { metadataKey: string };

/**
 * Where a slot keeps its items, as data: in this process (`in-memory`), JSON
 * files under `baseDir/dir` (`file`), or vectors in a SQLite file under
 * `baseDir/path` (`sqlite-vector`, embedded by the host-built embedder named
 * `embedder`, e.g. 'openai/text-embedding-3-small'; `path` defaults to
 * '.lousho/memory.db').
 */
export type MemoryProviderSpec =
  | { type: 'in-memory'; maxItems?: number }
  | { type: 'file'; dir: string; maxItems?: number }
  | { type: 'sqlite-vector'; path?: string; embedder: string; maxItems?: number; minScore?: number };

/** One `spec.memory` entry: the data form of `defineMemory()`'s options. */
export interface MemorySpec {
  /** Slot name: 1-55 characters of `A-Za-z0-9_-` (same rule as `defineMemory`). */
  name: string;
  /** What this memory holds; shown to the model in the tool descriptions. */
  description?: string;
  scope: MemoryScopeSpec;
  provider: MemoryProviderSpec;
  /** Recall at the start of a run (defineMemory's `recall`, defaults applied by it). */
  recall?: { onSessionStart?: boolean; maxItems?: number; query?: 'last-input' | 'none' };
  /** Which `remember`/`recall`/`forget` tools the model gets (defineMemory's `expose`). */
  expose?: { remember?: boolean; recall?: boolean; forget?: boolean };
  /** JSON Schema (draft 7) of one item; the host turns it into the slot's `itemSchema`. */
  itemJsonSchema?: Record<string, unknown>;
  /** The `itemJsonSchema` field (or fields) identifying an item for upserts; only valid with `itemJsonSchema`. */
  itemKey?: string | string[];
}

const scopeSchema = z.union([
  z.enum(['global', 'session']),
  z
    .object({ metadataKey: z.string(typeErrors({ invalid: 'must be a string' })).min(1, 'must not be empty') })
    .strict(),
]);

const providerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('in-memory'), maxItems: maxItems.optional() }).strict(),
  z.object({ type: z.literal('file'), dir: relativePathSchema, maxItems: maxItems.optional() }).strict(),
  z
    .object({
      type: z.literal('sqlite-vector'),
      path: relativePathSchema.optional(),
      embedder: z
        .string(typeErrors({ required: 'is required', invalid: 'must be a string' }))
        .min(1, "must name an embedder id such as 'openai/text-embedding-3-small'"),
      maxItems: maxItems.optional(),
      minScore: z.number().min(0, 'must be between 0 and 1').max(1, 'must be between 0 and 1').optional(),
    })
    .strict(),
]);

/**
 * One `spec.memory` entry (zod): strict objects, so misspelt keys are refused;
 * `itemKey` requires `itemJsonSchema` (the fields it names are fields of the schema).
 */
// fallow-ignore-next-line unused-export -- composed by memoryListSchema; exported for section schemas that embed it
export const memorySpecSchema = z
  .object({
    name: z
      .string(typeErrors({ required: 'is required', invalid: 'must be a string' }))
      .regex(SLOT_NAME, "must be 1-55 characters of A-Z, a-z, 0-9, '_' and '-'"),
    description: z.string(typeErrors({ invalid: 'must be a string' })).min(1, 'must not be empty').optional(),
    scope: scopeSchema,
    provider: providerSchema,
    recall: z
      .object({
        onSessionStart: z.boolean().optional(),
        maxItems: maxItems.optional(),
        query: z.enum(['last-input', 'none']).optional(),
      })
      .strict()
      .optional(),
    expose: z
      .object({
        remember: z.boolean().optional(),
        recall: z.boolean().optional(),
        forget: z.boolean().optional(),
      })
      .strict()
      .optional(),
    itemJsonSchema: z.record(z.string(), z.unknown()).optional(),
    itemKey: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
  })
  .strict()
  .superRefine((entry, ctx) => {
    if (entry.itemKey !== undefined && entry.itemJsonSchema === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['itemKey'], message: 'itemKey needs itemJsonSchema' });
    }
  });

/** Flags each repeated slot `name` at `[index, 'name']`. */
function refineUniqueNames(items: ReadonlyArray<{ name?: string }>, ctx: z.RefinementCtx): void {
  const seen = new Set<string>();
  for (let index = 0; index < items.length; index++) {
    const name = items[index].name;
    if (name === undefined) continue;
    if (seen.has(name)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate memory name '${name}'`, path: [index, 'name'] });
    } else {
      seen.add(name);
    }
  }
}

/** The `spec.memory` list (zod): each slot name must be unique (the tools are named after it). */
export const memoryListSchema = z.array(memorySpecSchema).superRefine(refineUniqueNames);
