import { describe, it, expect } from 'vitest';
import type { AuthorTurn } from '../../turnRunner';
import { authorDraftSchema, authorPatchSchema } from '../../draft/schema';
import { buildAuthorTools, type AuthorToolDeps, type CatalogService } from '../index';
import type { WorkspaceContext } from '../../../workspace/context';
import type { AgentRepo } from '../../../storage/agentRepo';
import type { VersionStore } from '../../../storage/versionStore';
import { AuthorSessionStore } from '../../sessionStore';

/**
 * Every field of every Author tool's input schema carries a non-empty
 * `.describe()` - the model only ever sees the description, so an
 * undocumented field is an undocumented contract. The walk unwraps
 * optionals/defaults/effects and descends objects, arrays, unions and
 * record value types; a field may put its description anywhere on its own
 * wrapper chain, but container children (elements, options, record
 * values) each need one too. AA07's spec-derived draft/patch schemas are
 * leaf boundaries: their per-key describes are pinned by
 * draft/__tests__/schema.test.ts and their inner nodes are the SDK's own
 * `agentSpecV2Schema`, which carries no describes by design.
 */

const TURN: AuthorTurn = {
  sessionId: 'sess-1',
  requestId: 'req-test',
  focus: { mode: 'create' },
  storedTranscript: [],
  userMessage: { id: 'm-1', role: 'user', text: 'hi', at: '2026-01-01T00:00:00.000Z' },
  signal: new AbortController().signal,
  stepsRemaining: () => 12,
  state: new Map(),
};

const DEPS: AuthorToolDeps = {
  workspace: async () =>
    ({
      repo: { listIds: () => [], readSpec: async () => undefined, readMeta: async () => ({}) } as unknown as AgentRepo,
      versions: { latest: async () => undefined } as unknown as VersionStore,
    }) as WorkspaceContext,
  catalog: {
    listModels: () => [],
    listTools: () => [],
    listGuardrails: () => [],
    listTriggerTypes: () => [],
    listSkills: async () => [],
    listKits: async () => [],
    listRegistryMcpServers: async () => [],
  } satisfies CatalogService,
  templates: { list: async () => [] },
  probeMcp: async () => ({ ok: true, tools: [] }),
  docsDir: '/nonexistent-docs',
  reviewDraft: async () => ({ pass: true }),
  requirements: async () => [],
  sessions: new AuthorSessionStore('/unused-sessions'),
};

/** The zod internals the walk reads (zod 3 `_def` fields, structurally typed). */
interface ZodLike {
  _def?: {
    typeName?: string;
    innerType?: unknown;
    schema?: unknown;
    in?: unknown;
    type?: unknown;
    shape?: () => Record<string, unknown>;
    valueType?: unknown;
    options?: unknown[];
  };
  description?: string;
}

/** The schema a wrapper type wraps: optional/nullable/default/readonly → innerType, effects → schema, brand/pipeline → type/in. */
function wrapped(def: NonNullable<ZodLike['_def']>): ZodLike | undefined {
  switch (def.typeName) {
    case 'ZodOptional':
    case 'ZodNullable':
    case 'ZodDefault':
    case 'ZodReadonly':
      return def.innerType as ZodLike;
    case 'ZodEffects':
      return def.schema as ZodLike;
    case 'ZodBranded':
      return def.type as ZodLike;
    case 'ZodPipeline':
      return def.in as ZodLike;
    default:
      return undefined;
  }
}

/** `schema` or its unwrapped inner carries a non-empty description. */
function described(schema: ZodLike): boolean {
  let current: ZodLike | undefined = schema;
  while (current !== undefined) {
    if (typeof current.description === 'string' && current.description.trim() !== '') return true;
    const def = current._def;
    if (def === undefined) return false;
    current = wrapped(def);
    if (current === undefined) return false;
  }
  return false;
}

/** The structural children of `schema`: object fields, array elements, union options, record values. */
function children(schema: ZodLike): [string, ZodLike][] {
  const def = schema._def;
  if (def === undefined) return [];
  const inner = wrapped(def);
  if (inner !== undefined) return children(inner);
  switch (def.typeName) {
    case 'ZodObject':
      return Object.entries(def.shape!()).map(([key, value]) => [key, value as ZodLike] as [string, ZodLike]);
    case 'ZodArray':
      return [['[]', def.type as ZodLike]];
    case 'ZodRecord':
      return [['.*', def.valueType as ZodLike]];
    case 'ZodUnion':
    case 'ZodDiscriminatedUnion':
      return (def.options as ZodLike[]).map((option, index) => [`|${index}`, option]);
    default:
      return [];
  }
}

/**
 * Whether `schema` unwraps to one of AA07's spec-derived draft/patch
 * schemas. Those are leaf boundaries for this walk: their top-level keys
 * all carry FIELD_DESCRIPTIONS (asserted by draft/__tests__/schema.test.ts)
 * and their inner nodes are the SDK's `agentSpecV2Schema` itself, which
 * ships no `.describe()`s - the propose tools' describe contract lives at
 * the draft/patch field and its direct keys. Identity is by shape: a
 * `.describe()` clone shares the same `_def.shape` result.
 */
function isSpecBoundary(schema: ZodLike): boolean {
  let current: ZodLike | undefined = schema;
  while (current !== undefined) {
    const def = current._def;
    if (def === undefined) return false;
    if (def.typeName === 'ZodObject') {
      const shape = def.shape?.();
      return shape === authorDraftSchema.shape || shape === authorPatchSchema.shape;
    }
    current = wrapped(def);
  }
  return false;
}

function missingDescriptions(root: ZodLike): string[] {
  const missing: string[] = [];
  const walk = (schema: ZodLike, path: string, isRoot: boolean): void => {
    // The root input object needs no describe of its own; every other node does.
    if (!isRoot && !described(schema)) missing.push(path === '' ? '<root>' : path);
    // Spec-derived draft/patch schemas are leaf boundaries (see isSpecBoundary).
    if (isSpecBoundary(schema)) return;
    for (const [key, child] of children(schema)) {
      walk(child, path === '' ? key : `${path}.${key}`, false);
    }
  };
  walk(root, '', true);
  return missing;
}

describe('Author tool input describe coverage', () => {
  const tools = buildAuthorTools(TURN, DEPS);
  for (const tool of tools) {
    const name = (tool as { name?: string }).name ?? tool.displayName;
    it(`${name}: every input field has a .describe()`, () => {
      const input = (tool as { inputSchema?: unknown }).inputSchema as ZodLike;
      expect(missingDescriptions(input)).toEqual([]);
    });
  }
});
