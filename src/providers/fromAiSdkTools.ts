/**
 * AI SDK tools (`tool({ ... })` from `ai`, or the plain objects passed to
 * `generateText({ tools })` / `new ToolLoopAgent({ tools })`) as Lousho tools.
 *
 * The conversion is structural: this module does not import `ai`, so it
 * works with tools built on any `ai` major (v4 `parameters`, v5+
 * `inputSchema`) whatever `ai` version is installed, and with none.
 */

import type { ApprovalCheckContext, ToolExecutionContext } from '../types';
import type { Message } from './llm';
import { defineTool, type DefinedTool } from '../tools/defineTool';
import { jsonSchemaToZod } from '../tools/mcp/schema';
import { isModelSchema } from '../utils/zodCompat';
import { ConfigurationError, ToolExecutionError } from '../execution/errors';

/** The options an AI SDK tool's `execute` and `needsApproval` receive, as far as Lousho has equivalents. */
export interface AiSdkToolCallOptions {
  /** The model's id for this call. */
  toolCallId: string;
  /** The transcript the model had seen, as Lousho `Message`s (not AI SDK `ModelMessage`s). */
  messages: readonly Message[];
  /** The run's cancellation signal (execute only). */
  abortSignal?: AbortSignal;
}

/**
 * An AI SDK tool, structurally: `description`, a schema (`inputSchema` on
 * `ai` v5+, `parameters` on v4) that is a zod schema, a Standard Schema, an
 * `ai` `jsonSchema()` / `zodSchema()` wrapper or a plain JSON Schema, an
 * `execute`, and an optional `needsApproval`.
 */
export interface AiSdkToolLike {
  /** A string, or (`ai` v7) a function of the tool context, called once with an empty context. */
  description?: string | ((options: never) => unknown);
  /** The argument schema (`ai` v5+). */
  inputSchema?: unknown;
  /** The argument schema (`ai` v4), read when `inputSchema` is not set. */
  parameters?: unknown;
  /** Called with the input and {@link AiSdkToolCallOptions}; typed loosely so any `ai` major's tool is accepted. */
  execute?: (input: never, options: never) => unknown;
  /** A boolean, or a function of the input and {@link AiSdkToolCallOptions}. */
  needsApproval?: boolean | ((input: never, options: never) => unknown);
  /** `'provider-defined'` / `'provider'` marks a tool the model provider runs, which is rejected. */
  type?: string;
}

/** An `ai` `Schema` wrapper (`jsonSchema()`, `zodSchema()`, or a v4 `jsonSchema()`): a JSON Schema plus an optional validator. */
interface AiSchemaWrapper {
  jsonSchema: unknown;
  validate?: (value: unknown) => unknown;
}

function isAiSchemaWrapper(value: unknown): value is AiSchemaWrapper {
  return typeof value === 'object' && value !== null && 'jsonSchema' in value && !('~standard' in value);
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function';
}

/** A zod object built from a JSON Schema: the same permissive conversion MCP tools use. */
function zodFromJsonSchema(name: string, schema: unknown): ReturnType<typeof jsonSchemaToZod> {
  if (isPromiseLike(schema)) {
    throw new ConfigurationError(
      `fromAiSdkTools(): tool '${name}' has a lazily resolved (async) JSON Schema, which cannot be converted up front. Pass the JSON Schema object to jsonSchema() directly.`,
      'tools'
    );
  }
  return jsonSchemaToZod(schema ?? { type: 'object', properties: {} });
}

/** The tool's schema as one `defineTool` accepts, plus the wrapper's custom validator when it has one. */
function inputOf(name: string, tool: AiSdkToolLike): { input: unknown; validate?: AiSchemaWrapper['validate'] } {
  const schema = tool.inputSchema ?? tool.parameters;
  if (schema === undefined || schema === null) return { input: zodFromJsonSchema(name, undefined) };
  if (isModelSchema(schema)) return { input: schema };
  if (isAiSchemaWrapper(schema)) {
    const validate = typeof schema.validate === 'function' ? schema.validate.bind(schema) : undefined;
    return { input: zodFromJsonSchema(name, schema.jsonSchema), validate };
  }
  if (typeof schema === 'object' && !Array.isArray(schema)) return { input: zodFromJsonSchema(name, schema) };
  throw new ConfigurationError(
    `fromAiSdkTools(): tool '${name}' has an unsupported schema (${typeof schema}). Use a zod schema, a Standard Schema, or ai's jsonSchema().`,
    'tools'
  );
}

/** Runs an `ai` schema wrapper's own validator (sync on v4, async on v5+) and returns its parsed value. */
async function validated(name: string, validate: NonNullable<AiSchemaWrapper['validate']>, args: unknown): Promise<unknown> {
  const result = (await validate(args)) as { success?: boolean; value?: unknown; error?: unknown } | undefined;
  if (!result || result.success !== false) return result && 'value' in result ? result.value : args;
  const reason = result.error instanceof Error ? result.error.message : String(result.error);
  throw new ToolExecutionError(`Invalid arguments for tool '${name}': ${reason}`, name);
}

function callOptions(ctx: ApprovalCheckContext | ToolExecutionContext): AiSdkToolCallOptions {
  const abortSignal = 'abortSignal' in ctx ? ctx.abortSignal : undefined;
  return { toolCallId: ctx.toolCallId, messages: ctx.messages, ...(abortSignal && { abortSignal }) };
}

/** The description: a string, or what an `ai` v7 description function returns for an empty context. */
function descriptionOf(name: string, tool: AiSdkToolLike): string {
  const description: unknown = typeof tool.description === 'function' ? (tool.description as (options: unknown) => unknown)({ context: {} }) : tool.description;
  return typeof description === 'string' && description.trim() !== '' ? description : name;
}

/** One AI SDK tool as a Lousho tool named `name`. */
function convert(name: string, tool: AiSdkToolLike): DefinedTool {
  if (typeof tool !== 'object' || tool === null) {
    throw new ConfigurationError(`fromAiSdkTools(): tool '${name}' is not a tool object.`, 'tools');
  }
  if (tool.type === 'provider-defined' || tool.type === 'provider') {
    throw new ConfigurationError(
      `fromAiSdkTools(): tool '${name}' is a provider-defined tool (run by the model provider); use Lousho's hosted tools instead, e.g. webSearch(). See docs/hosted-tools.md.`,
      'tools'
    );
  }
  const run = tool.execute as ((input: unknown, options: AiSdkToolCallOptions) => unknown) | undefined;
  if (typeof run !== 'function') {
    throw new ConfigurationError(
      `fromAiSdkTools(): tool '${name}' has no execute (an AI SDK client-side tool). Lousho runs tools on the server; ` +
        'give it an execute, or use needsApproval / the ask_question tool for input from the user.',
      'tools'
    );
  }
  const { input, validate } = inputOf(name, tool);
  const check = tool.needsApproval as boolean | ((input: unknown, options: AiSdkToolCallOptions) => boolean | PromiseLike<boolean>) | undefined;
  const needsApproval =
    typeof check === 'function' ? async (args: unknown, ctx: ApprovalCheckContext) => Boolean(await check.call(tool, args, callOptions(ctx))) : check;
  return defineTool({
    name,
    description: descriptionOf(name, tool),
    input: input as Parameters<typeof defineTool>[0]['input'],
    ...(needsApproval !== undefined && { needsApproval }),
    // A returned AsyncIterable (AI SDK preliminary results) streams as `tool.partial`; the last value is the result.
    execute: async (args: unknown, ctx: ToolExecutionContext) => {
      const parsed = validate ? await validated(name, validate, args) : args;
      return run.call(tool, parsed, callOptions(ctx));
    },
  });
}

/**
 * AI SDK tools as Lousho tools, for `createAgent({ tools })`. Takes the
 * record you pass to `generateText({ tools })` or `new ToolLoopAgent({ tools })`;
 * each key becomes the tool's name.
 *
 * - The schema is `inputSchema` (`ai` v5+) or `parameters` (`ai` v4): zod 3/4
 *   and Standard Schemas are used as they are; `jsonSchema()` wrappers and
 *   plain JSON Schemas are converted to zod (as MCP tool schemas are), and a
 *   wrapper's own `validate` still runs before `execute`.
 * - `execute(input, { toolCallId, messages, abortSignal })` gets Lousho's call
 *   id, transcript (Lousho `Message`s) and the run's abort signal. A thrown
 *   error becomes a tool error the model sees; a returned async iterable
 *   streams its values as `tool.partial` events, the last one being the result.
 * - `needsApproval` (boolean, or a function of the input) maps to Lousho's
 *   `needsApproval`: the run pauses with `finishReason: 'awaiting-approval'`.
 *
 * Throws `LOUSHO_CONFIG_INVALID` for a tool without `execute`, a
 * provider-defined tool, or a key that is not a valid tool name.
 *
 * @example
 * ```ts
 * // tool() from the ai package
 * const weather = tool({ description: 'Get the weather', inputSchema: z.object({ city: z.string() }), execute: async ({ city }) => `Sunny in ${city}` });
 * const agent = createAgent({ provider: fromAiSdk(openai('gpt-4o')), tools: fromAiSdkTools({ weather }) });
 * ```
 */
export function fromAiSdkTools(tools: Readonly<Record<string, AiSdkToolLike>>): DefinedTool[] {
  if (typeof tools !== 'object' || tools === null || Array.isArray(tools)) {
    throw new ConfigurationError('fromAiSdkTools() takes a record of AI SDK tools keyed by name, like generateText({ tools }).', 'tools');
  }
  return Object.entries(tools).map(([name, tool]) => convert(name, tool));
}
