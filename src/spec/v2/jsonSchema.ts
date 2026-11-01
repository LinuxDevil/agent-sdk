/**
 * JSON Schema (draft 7) of AgentSpec v2. Computed on first call from
 * agentSpecV2Schema with the same converter the SDK uses for structured output,
 * then memoized and deep-frozen. Browser-safe: imports zod-side code and 'ai'
 * only, no node: imports.
 */
import { zodSchema } from 'ai';
import { schemaToJsonSchema } from '../../utils/zodCompat';
import { agentSpecV2Schema } from './schema';

/** One sentence per top-level key: what it does, in plain words. */
export const SPEC_FIELD_DESCRIPTIONS: Readonly<Record<string, string>> = {
  version: 'Spec format version. Always 2.',
  name: 'Display name of the agent. Letters, digits, spaces, dots, underscores and dashes; up to 64 characters.',
  description: 'What the agent does, in one or two sentences. Required when another agent delegates or hands off to it.',
  model: 'Model as provider/model, for example anthropic/claude-sonnet-5-5.',
  fallbackModels: 'Models to try, in order, when the main model fails.',
  instructions: 'The system prompt, as text or as { file } relative to the agent folder.',
  instructionsByFamily: 'Extra instructions appended when the model id contains the key, for example openai.',
  promptRef: 'A prompt registry reference name@label. The instructions are the fallback when it cannot be fetched.',
  modelSettings: 'Sampling settings such as temperature, topP and maxOutputTokens.',
  reasoning: 'How hard the model thinks before answering, or a token budget.',
  tools: 'Tools the agent can call: built-in, registry, file, integration, OpenAPI, hosted or hub.',
  mcpServers: 'MCP servers whose tools the agent can call, keyed by a short name.',
  skills: 'Skills the agent can load on demand: a folder, a registry skill or inline text.',
  memory: 'Named long-term memory slots the agent reads and writes.',
  subagents: 'Other agents this agent can delegate tasks to, keyed by name.',
  subagentOptions: 'How delegated tasks run.',
  maxSubagentDepth: 'How many levels of delegation are allowed.',
  handoffs: 'Agents this agent can pass the whole conversation to.',
  maxHandoffs: 'Most handoffs in one run.',
  guardrails: 'Checks on input, output and tool arguments that can block or rewrite text.',
  permissions: 'Rules that allow, deny or ask before tool calls, matched by tool name and arguments.',
  permissionMode: 'Default permission mode for the agent\'s tool calls.',
  approvalTtlMs: 'How long a pending approval stays open, in milliseconds.',
  askQuestion: 'Lets the agent pause and ask the user a question.',
  hooks: 'Code that runs before or after tool calls and model calls.',
  output: 'A JSON Schema the final answer must match.',
  limits: 'Budgets per run: tokens, cost, time, steps and tool errors.',
  maxSteps: 'Most model steps in one run.',
  compaction: 'Shortens long conversations so they fit the context window.',
  retry: 'How failed model calls are retried.',
  rateLimit: 'Caps on requests and tokens per minute.',
  promptCaching: 'Lets the provider cache the stable start of the prompt.',
  toolSearch: 'Hides most tools until the model searches for them.',
  codeMode: 'Lets the model write a short program that calls several tools at once.',
  triggers: 'What starts a run: chat, a schedule, a webhook, a channel or another agent finishing.',
  abortListeners: 'Events that cancel a queued or running run.',
  flow: 'An optional step-by-step workflow the agent runs instead of a single chat turn.',
  evals: 'Datasets and pass gates checked before the agent is published.',
};

/** Deep-freezes an object and all nested objects/arrays. */
function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) {
    Object.freeze(obj);
    for (const item of obj) deepFreeze(item);
    return obj;
  }
  Object.freeze(obj);
  for (const value of Object.values(obj)) deepFreeze(value);
  return obj;
}

/** Removes `$schema` keys below the root (the converter may emit them). */
function stripNestedSchemas(obj: unknown): void {
  if (obj === null || typeof obj !== 'object') return;
  if (Array.isArray(obj)) {
    for (const item of obj) stripNestedSchemas(item);
    return;
  }
  delete (obj as Record<string, unknown>).$schema;
  for (const value of Object.values(obj)) stripNestedSchemas(value);
}

/** Applies field descriptions to a JSON Schema's properties. */
function applyDescriptions(schema: Record<string, unknown>): void {
  const props = schema.properties as Record<string, Record<string, unknown>> | undefined;
  if (!props) return;
  for (const [key, prop] of Object.entries(props)) {
    if (!prop.description && SPEC_FIELD_DESCRIPTIONS[key]) {
      prop.description = SPEC_FIELD_DESCRIPTIONS[key];
    }
  }
}

/** Converts agentSpecV2Schema to JSON Schema and post-processes it. */
function convert(): Readonly<Record<string, unknown>> {
  const converted = schemaToJsonSchema(agentSpecV2Schema) ?? (zodSchema(agentSpecV2Schema as never).jsonSchema as Record<string, unknown>);
  const schema = structuredClone(converted) as Record<string, unknown>;
  schema.$schema = 'http://json-schema.org/draft-07/schema#';
  schema.title = 'AgentSpec v2';
  schema.additionalProperties = false;
  applyDescriptions(schema);
  for (const value of Object.values(schema)) stripNestedSchemas(value);
  return deepFreeze(schema);
}

/** Memoized JSON Schema of AgentSpec v2. */
let cached: Readonly<Record<string, unknown>> | undefined;

/**
 * JSON Schema (draft 7) of AgentSpec v2. Computed on first call from
 * agentSpecV2Schema with the same converter the SDK uses for structured output,
 * then memoized and deep-frozen.
 */
export function agentSpecV2JsonSchema(): Readonly<Record<string, unknown>> {
  if (!cached) cached = convert();
  return cached;
}
