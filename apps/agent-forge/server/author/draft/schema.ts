/**
 * The zod schemas of what the Author may send (PLAN §8.2):
 * `authorDraftSchema` is the `draft` of `proposeAgent` - AgentSpec v2
 * projected down to the fields a model may set (`version`, `evals` and
 * `flow` are never the model's), with `description` required and
 * `instructions` always a string. `authorPatchSchema` is the `patch` of
 * `proposeAgentUpdate`: every draft key optional ("omitted = keep"), the
 * spec-optional ones nullable ("null = reset to default").
 *
 * Both are derived from the SDK's `agentSpecV2Schema` - never re-declared
 * - so the Author cannot drift from what a saved spec may hold, and every
 * field carries a `.describe()` (FIELD_DESCRIPTIONS) that the tool input's
 * JSON Schema surfaces to the model.
 */
import { z } from 'zod';
import { agentSpecV2Schema } from 'lousho';
import type { AgentSpecV2 } from 'lousho';

/** The spec keys the Author never sets: `version` is forced to 2, `evals` and `flow` are not in v1 of the Author. */
export const DRAFT_OMITTED_KEYS = ['version', 'evals', 'flow'] as const;

const specShape = agentSpecV2Schema.shape as z.ZodRawShape;

/**
 * One sentence per draftable field - what the field does, when to set it,
 * and which list tool to copy values from. Must cover exactly the keys of
 * `authorDraftSchema`: the model only ever sees these descriptions, so a
 * spec key added without a row fails schema.test.ts until one is written.
 */
export const FIELD_DESCRIPTIONS: Readonly<Record<string, string>> = {
  name: 'Short human name, unique among agents. Letters, digits, spaces, dots, underscores, dashes; up to 64 characters.',
  description: 'One plain sentence saying what the agent does and for whom.',
  model: 'Model id as provider/model, copied from listModels.',
  fallbackModels: 'Model ids to try in order when the main model fails. Only when the user asks.',
  instructions:
    "The agent's system prompt: the job, the steps, the tools each step uses, and what it must never do.",
  instructionsByFamily:
    'Extra instructions appended when the model id contains the key, e.g. { "claude": "..." }. Rarely needed.',
  promptRef: 'Prompt registry reference name@label. instructions stays as the fallback. Only when the user asks.',
  modelSettings: 'Sampling settings such as temperature and maxOutputTokens. Only when the user asks.',
  reasoning: 'Reasoning effort off, low, medium or high, or { budgetTokens }. Only when the user asks.',
  tools:
    'Tool references: { builtin }, { registry }, { integration }, { openapi }, { hosted } or { hub }. The smallest set that covers the instructions.',
  mcpServers: 'MCP servers by key. Secrets as { "secret": NAME } or { "env": VAR }, never literal values.',
  skills: 'Skills to attach: { dir }, { registry } or { inline: { name, description, content } }.',
  memory: 'Memory slots with name, scope, provider, recall and expose.',
  subagents: 'Subagents by name: { ref: agentId }, { inline: spec } or { remote: { url, description } }.',
  subagentOptions: '{ parallel, readOnly } for subagent calls.',
  maxSubagentDepth: 'How deep subagents may nest. Default 1.',
  handoffs: 'Agents this one can hand the conversation to: { agent, description?, inputFilter? }.',
  maxHandoffs: 'Maximum handoffs per run. Default 5.',
  guardrails: 'Guardrails with id, name from listGuardrails, on input/output/both, and options.',
  permissions: 'Permission rules with id, tool glob, optional when matcher, and action allow, deny, ask or auto.',
  permissionMode: 'Default permission mode. Leave unset unless the user asks.',
  approvalTtlMs: 'How long a pending approval stays answerable, in milliseconds.',
  askQuestion: 'true lets the agent ask the user a question mid-run.',
  hooks: 'Hooks: { id, file } or { id, inline: { name, point, code } }. Inline code runs sandboxed.',
  output: "{ jsonSchema } when another system reads the agent's answer as JSON.",
  limits: 'Run limits such as maxCostUsd or maxDurationMs. Only when the user asks.',
  maxSteps: 'Maximum model steps per run.',
  compaction: 'true or { thresholdPercent } to summarise long conversations.',
  retry: 'false, or { maxRetries, backoff, timeoutMs } for provider retries.',
  rateLimit: '{ requestsPerMinute, tokensPerMinute }.',
  promptCaching: 'false turns provider prompt caching off. Default on.',
  toolSearch: '{ enabled, maxResults } to load tools on demand when there are many.',
  codeMode: '{ enabled } to let the model call tools from code.',
  triggers: 'What starts the agent: chat, cron, webhook, channel or agent. Always keep a chat trigger.',
  abortListeners: 'Rules that cancel queued or running runs of a trigger when a matching event arrives.',
};

/** The longest instructions text the Author may write in one draft. */
const INSTRUCTIONS_MAX_CHARS = 50_000;

/** The draft's description cap: one sentence, stricter than the spec's 1024. */
const DESCRIPTION_MAX_CHARS = 500;

/**
 * `agentSpecV2Schema`'s fields minus {@link DRAFT_OMITTED_KEYS}, with the
 * two overrides the Author contract adds: `description` is required and
 * capped (the spec makes it optional at 1024, but the Author always
 * writes the one-sentence pitch a subagent or handoff target needs), and
 * `instructions` is a plain string - the Author never writes `{ file }`.
 * Every field keeps the spec's own validation (`name`, `model`, ... are
 * required exactly where the spec requires them) and is `.describe()`d.
 */
function draftFieldSchemas(): Record<string, z.ZodTypeAny> {
  const omitted: readonly string[] = DRAFT_OMITTED_KEYS;
  return Object.fromEntries(
    Object.entries(specShape)
      .filter(([key]) => !omitted.includes(key))
      .map(([key, field]) => {
        const schema =
          key === 'description'
            ? z.string().min(1, 'must not be empty').max(DESCRIPTION_MAX_CHARS, `must be at most ${DESCRIPTION_MAX_CHARS} characters`)
            : key === 'instructions'
              ? z.string().min(1, 'must not be empty').max(INSTRUCTIONS_MAX_CHARS, `must be at most ${INSTRUCTIONS_MAX_CHARS} characters`)
              : field;
        return [key, schema.describe(FIELD_DESCRIPTIONS[key])];
      })
  );
}

/** The described draft fields both schemas are built from. */
const DRAFT_FIELDS = draftFieldSchemas();

/**
 * `AgentSpecV2` as the Author may set it: every key except
 * {@link DRAFT_OMITTED_KEYS}, `description` required and `instructions`
 * narrowed to a string.
 */
type AuthorDraftFields = Omit<AgentSpecV2, (typeof DRAFT_OMITTED_KEYS)[number] | 'description' | 'instructions'> & {
  /** One plain sentence saying what the agent does and for whom; required of a draft. */
  description: string;
  /** The system prompt, always as text. */
  instructions: string;
};

/**
 * The keys a patch may `null` ("reset to default"): every optional
 * top-level key of `agentSpecV2Schema` except `description` - a null
 * description is a mistake, not a reset, since the Author always keeps
 * the one-sentence pitch true. Computed from the schema's shape so an
 * optional field the spec gains is resettable automatically.
 */
export const NULLABLE_PATCH_KEYS: readonly string[] = Object.entries(specShape)
  .filter(([key, field]) => key !== 'description' && field.isOptional())
  .map(([key]) => key);

/**
 * What `proposeAgent` takes as `draft`: a whole new agent, strict so an
 * unknown key fails rather than silently landing in the spec.
 */
export const authorDraftSchema = z.object(DRAFT_FIELDS).strict() as unknown as z.ZodObject<
  z.ZodRawShape,
  'strict',
  z.ZodTypeAny,
  AuthorDraftFields,
  AuthorDraftFields
>;

/** A draft the Author sent, validated: the spec minus the model-never-sets keys. */
export type AuthorDraft = z.infer<typeof authorDraftSchema>;

/** The `AgentSpecV2` keys declared optional (the ones {@link NULLABLE_PATCH_KEYS} computes). */
type OptionalSpecKeys = { [K in keyof AgentSpecV2]-?: undefined extends AgentSpecV2[K] ? K : never }[keyof AgentSpecV2];

/**
 * `AuthorDraft` as a patch: every key optional; the spec-optional fields
 * (all but `description`) also take `null`, meaning "reset to default".
 */
type AuthorPatchFields = {
  [K in keyof AuthorDraftFields]?: K extends Exclude<OptionalSpecKeys, 'description'>
    ? AuthorDraftFields[K] | null
    : AuthorDraftFields[K];
};

/**
 * What `proposeAgentUpdate` takes as `patch`: every draft key optional
 * (omitted = keep), the {@link NULLABLE_PATCH_KEYS} ones also `null`.
 * The parsed patch preserves `null` values; `applyAuthorPatch` reads them.
 */
export const authorPatchSchema = z
  .object(
    Object.fromEntries(
      Object.entries(DRAFT_FIELDS).map(([key, field]) => [
        key,
        (NULLABLE_PATCH_KEYS.includes(key) ? field.nullable() : field).optional().describe(FIELD_DESCRIPTIONS[key]),
      ])
    )
  )
  .strict() as unknown as z.ZodObject<z.ZodRawShape, 'strict', z.ZodTypeAny, AuthorPatchFields, AuthorPatchFields>;

/** A patch the Author sent, validated: partial draft fields plus `null` resets. */
export type AuthorPatch = z.infer<typeof authorPatchSchema>;
