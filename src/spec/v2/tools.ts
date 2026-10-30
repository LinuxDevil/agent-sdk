/**
 * The `spec.tools` section of AgentSpec v2: a list of `ToolRef`s, one object
 * per tool source — `{ builtin }` for an SDK built-in, `{ registry }` for a
 * `lousho add` install, `{ file }` for an agentDir-local file, `{ integration }`
 * and `{ openapi }` for credentialed connectors, `{ hosted }` for a
 * provider-run tool and `{ hub }` for the Context Hub pair. Every ref may
 * carry an `id` (its `tool:<id>` canvas node id); the common refs may also
 * carry `approval` and `deferLoading`. Kinds this SDK version cannot run are
 * refused at validation time with "not supported yet" issues, so a spec the
 * runtime cannot build is rejected, never stored. Browser-safe: no `node:*`
 * imports and no built-in tool imports — the factories live in
 * `src/tools/builtinRegistry.ts`, the resolution in `src/spec/v2/resolve/`.
 */
import { z } from 'zod';
import { closestMatch } from '../../utils/closestMatch';
import { forwardIssues, refineUniqueIds, relativePathSchema, specIdSchema } from './common';
import type { SecretRef } from './secrets';
import { addUnsupportedIssue } from './unsupported';

/** The key that selects a {@link ToolRef}'s variant; exactly one must be present on each ref. */
export const TOOL_REF_KINDS = ['builtin', 'registry', 'file', 'integration', 'openapi', 'hosted', 'hub'] as const;

/** A {@link TOOL_REF_KINDS} entry. */
export type ToolRefKind = (typeof TOOL_REF_KINDS)[number];

/** Keys every file/registry/builtin/integration/openapi ref may also carry. */
export interface ToolRefCommon {
  /** Canvas node id (`tool:<id>`); default: the builtin/registry/hosted name or the file's basename. */
  id?: string;
  /** 'always': every call asks; 'never': no call asks; 'auto': model-decided (not supported yet, R01). */
  approval?: 'always' | 'never' | 'auto';
  /** Withhold the tools from the model until tool_search finds them. */
  deferLoading?: boolean;
}

/** The credentialed integrations an `{ integration }` ref names (S05). */
export type IntegrationName = 'github' | 'jira' | 'slack' | 'email';

/** Options of an `{ openapi }` ref: one tool per selected operation (S05). */
export interface OpenApiToolRefOptions {
  url: string;
  include?: string[];
  exclude?: string[];
  approval?: 'mutating' | 'always' | 'never';
  bearerToken?: SecretRef;
}

/**
 * One `spec.tools` entry: exactly one kind key. `{ builtin }` names an SDK
 * built-in by its model-facing name (`web_fetch`), `{ registry }` an item
 * installed by `lousho add`, `{ file }` an agentDir-relative code file,
 * `{ integration }`/`{ openapi }` credentialed connectors, `{ hosted }` a
 * provider-run tool and `{ hub }` the Context Hub publish/query pair.
 */
export type ToolRef =
  | (ToolRefCommon & { builtin: string; options?: Record<string, unknown> })
  | (ToolRefCommon & { registry: string; version?: string })
  | (ToolRefCommon & { file: string })
  | (ToolRefCommon & { integration: IntegrationName; credentials: Record<string, string | SecretRef> })
  | (ToolRefCommon & { openapi: OpenApiToolRefOptions })
  | { id?: string; hosted: 'web_search' | 'code_interpreter' | 'file_search'; options?: Record<string, unknown> }
  | { id?: string; hub: true };

const positiveInt = z.number().int().positive();
const nonNegativeInt = z.number().int().min(0);
const stringList = z.array(z.string());

/** `createHttpTool`'s {@link HttpToolOptions} as strict data (the v2 spec has no field for a transport). */
const httpRequestOptions = z
  .object({
    timeout: positiveInt.optional(),
    maxRedirects: nonNegativeInt.optional(),
    validateSSL: z.boolean().optional(),
    allowPrivate: stringList.optional(),
  })
  .strict();

/** `createWebFetchTool`'s {@link WebFetchToolOptions} minus `transport`, as strict data. */
const webFetchOptions = z
  .object({
    timeoutMs: positiveInt.optional(),
    maxRedirects: nonNegativeInt.optional(),
    maxBytes: positiveInt.optional(),
    maxChars: positiveInt.optional(),
    allowedHosts: stringList.optional(),
    blockedHosts: stringList.optional(),
    allowPrivate: stringList.optional(),
    userAgent: z.string().optional(),
  })
  .strict();

/** `webSearch`'s {@link WebSearchOptions} as strict data. */
const webSearchOptions = z
  .object({
    maxUses: positiveInt.optional(),
    allowedDomains: stringList.optional(),
    blockedDomains: stringList.optional(),
    searchContextSize: z.enum(['low', 'medium', 'high']).optional(),
    userLocation: z
      .object({
        country: z.string().optional(),
        city: z.string().optional(),
        region: z.string().optional(),
        timezone: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** `codeInterpreter`'s {@link CodeInterpreterOptions} as strict data. */
const codeInterpreterOptions = z
  .object({
    container: z.string().optional(),
  })
  .strict();

/** `fileSearch`'s {@link FileSearchOptions} as strict data; `vectorStoreIds` is required there. */
const fileSearchOptions = z
  .object({
    vectorStoreIds: stringList.min(1),
    maxResults: positiveInt.optional(),
  })
  .strict();

/**
 * The options each `{ builtin }` name takes (strict zod), or null for none.
 * Keys are the model-facing names; `src/tools/builtinRegistry.ts`'s mapped
 * factory type keeps this key set and the builders equal at compile time.
 */
export const BUILTIN_TOOL_OPTIONS: {
  current_date: null;
  day_name: null;
  http_request: z.ZodTypeAny;
  web_fetch: z.ZodTypeAny;
  todo: null;
} = {
  current_date: null,
  day_name: null,
  http_request: httpRequestOptions,
  web_fetch: webFetchOptions,
  todo: null,
};

/** The `{ builtin }` names a spec may write (BUILTIN_TOOL_OPTIONS key order). */
export const BUILTIN_TOOL_NAMES = Object.keys(BUILTIN_TOOL_OPTIONS) as readonly (keyof typeof BUILTIN_TOOL_OPTIONS)[];

/** The options each `{ hosted }` kind takes (strict zod), keyed by provider tool type. */
// fallow-ignore-next-line unused-export -- consumed by later spec v2 section schemas (S05 openapi options, S06 tool catalog)
export const HOSTED_TOOL_OPTIONS: { web_search: z.ZodTypeAny; code_interpreter: z.ZodTypeAny; file_search: z.ZodTypeAny } = {
  web_search: webSearchOptions,
  code_interpreter: codeInterpreterOptions,
  file_search: fileSearchOptions,
};

const INTEGRATION_NAMES: readonly string[] = ['github', 'jira', 'slack', 'email'];

const COMMON = {
  id: specIdSchema.optional(),
  approval: z.enum(['always', 'never', 'auto']).optional(),
  deferLoading: z.boolean().optional(),
};

const builtinVariant = z
  .object({
    ...COMMON,
    builtin: z.string(),
    options: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const registryVariant = z
  .object({
    ...COMMON,
    registry: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'must be a registry name such as github-issues'),
    version: z.string().optional(),
  })
  .strict();

const fileVariant = z
  .object({
    ...COMMON,
    file: relativePathSchema.refine(
      (value) => /\.(ts|mts|cts|js|mjs|cjs)$/.test(value),
      'must be a .ts, .mts, .cts, .js, .mjs or .cjs file'
    ),
  })
  .strict();

/** The variant of a kind the SDK cannot run yet: parses anything, then always raises "not supported yet" (S05 replaces it). */
function pendingVariant(kind: string) {
  return z.any().superRefine((_value, ctx) => {
    addUnsupportedIssue(ctx, `'${kind}' tool references cannot be run by this version of the SDK`);
  });
}

const hostedVariant = z
  .object({
    id: specIdSchema.optional(),
    hosted: z.enum(['web_search', 'code_interpreter', 'file_search']),
    options: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const hubVariant = z
  .object({
    id: specIdSchema.optional(),
    hub: z.literal(true),
  })
  .strict();

const VARIANTS: Record<ToolRefKind, z.ZodTypeAny> = {
  builtin: builtinVariant,
  registry: registryVariant,
  file: fileVariant,
  integration: pendingVariant('integration'),
  openapi: pendingVariant('openapi'),
  hosted: hostedVariant,
  hub: hubVariant,
};

/** Rule 1: the ref is a plain object with exactly one {@link TOOL_REF_KINDS} key; returns that kind or adds the issue. */
function kindOf(value: unknown, ctx: z.RefinementCtx): ToolRefKind | undefined {
  const kinds =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? TOOL_REF_KINDS.filter((kind) => kind in value)
      : [];
  if (kinds.length === 1) return kinds[0];
  ctx.addIssue({ code: z.ZodIssueCode.custom, message: `must have exactly one of ${TOOL_REF_KINDS.join(', ')}` });
  return undefined;
}

/** Rule 2: the kind's own strict variant; its issues are forwarded at their own paths. */
function variantOk(value: unknown, kind: ToolRefKind, ctx: z.RefinementCtx): boolean {
  const result = VARIANTS[kind].safeParse(value);
  forwardIssues(result, ctx);
  return result.success;
}

/** Whether `name` is one of {@link BUILTIN_TOOL_NAMES} (own keys only, so 'toString' is not one). */
function builtinName(name: string): keyof typeof BUILTIN_TOOL_OPTIONS | undefined {
  return Object.hasOwn(BUILTIN_TOOL_OPTIONS, name) ? (name as keyof typeof BUILTIN_TOOL_OPTIONS) : undefined;
}

/** Rule 3's unknown-name issue: an integration hint for the four names, a did-you-mean for the rest. */
function unknownBuiltinIssue(name: string, ctx: z.RefinementCtx): void {
  const message = INTEGRATION_NAMES.includes(name)
    ? `'${name}' is an integration: write { integration: '${name}', credentials: { ... } }`
    : `unknown builtin tool '${name}'${unknownBuiltinSuggestion(name)}. Available: ${BUILTIN_TOOL_NAMES.join(', ')}`;
  ctx.addIssue({ code: z.ZodIssueCode.custom, message, path: ['builtin'] });
}

/** ` (did you mean '<s>')` when `name` is plausibly a typo of a builtin name. */
function unknownBuiltinSuggestion(name: string): string {
  const suggestion = closestMatch(name, BUILTIN_TOOL_NAMES);
  return suggestion === undefined ? '' : ` (did you mean '${suggestion}')`;
}

/** Rule 3: the `{ builtin }` name is known, and its options match that builtin's schema (or absence). */
function checkBuiltin(entry: Record<string, unknown>, ctx: z.RefinementCtx): void {
  const name = String(entry['builtin']);
  const known = builtinName(name);
  if (known === undefined) {
    unknownBuiltinIssue(name, ctx);
    return;
  }
  const schema = BUILTIN_TOOL_OPTIONS[known];
  if (schema === null) {
    if (entry['options'] !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `'${name}' takes no options`, path: ['options'] });
    }
    return;
  }
  forwardIssues(schema.safeParse(entry['options'] ?? {}), ctx, ['options']);
}

/** Rule 4: a `{ hosted }` ref's options match the hosted kind's schema. */
function checkHosted(entry: Record<string, unknown>, ctx: z.RefinementCtx): void {
  const hosted = entry['hosted'] as keyof typeof HOSTED_TOOL_OPTIONS;
  forwardIssues(HOSTED_TOOL_OPTIONS[hosted].safeParse(entry['options'] ?? {}), ctx, ['options']);
}

/** Rule 5: `approval: 'auto'` is model-decided, which has no SDK mechanism yet (R01). */
function checkApproval(entry: Record<string, unknown>, ctx: z.RefinementCtx): void {
  if (entry['approval'] === 'auto') {
    addUnsupportedIssue(ctx, "approval 'auto' (model-decided approvals)", ['approval']);
  }
}

/** Rule 6: install receipts record no version, so `version` cannot be pinned yet. */
function checkRegistryVersion(kind: ToolRefKind, entry: Record<string, unknown>, ctx: z.RefinementCtx): void {
  if (kind === 'registry' && entry['version'] !== undefined) {
    addUnsupportedIssue(ctx, "registry 'version' (install receipts do not record versions)", ['version']);
  }
}

/** All the {@link ToolRef} rules; helpers run in order so every problem is reported at once. */
function refineToolRef(value: unknown, ctx: z.RefinementCtx): void {
  const kind = kindOf(value, ctx);
  if (kind === undefined || !variantOk(value, kind, ctx)) return;
  const entry = value as Record<string, unknown>;
  if (kind === 'builtin') checkBuiltin(entry, ctx);
  if (kind === 'hosted') checkHosted(entry, ctx);
  checkApproval(entry, ctx);
  checkRegistryVersion(kind, entry, ctx);
}

/**
 * One `spec.tools` entry (zod): accepts any value and reports the ToolRef
 * rules itself, so the "exactly one kind" and per-kind issues point at the
 * right paths instead of a union's generic failure.
 */
// fallow-ignore-next-line unused-export -- composed by toolRefListSchema; exported for section schemas that embed it
export const toolRefSchema = z.any().superRefine(refineToolRef);

/** The `spec.tools` list (zod): each entry's `id` must be unique. */
export const toolRefListSchema = z.array(toolRefSchema).superRefine(refineUniqueIds);
