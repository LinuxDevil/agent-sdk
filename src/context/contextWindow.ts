/**
 * Internal helpers shared by compaction and tool search (not exported from
 * the package): the context window of a request's model, with a one-time
 * warning when it is unknown, and the tokens a request spends outside its
 * messages (tool definitions and the output schema).
 */

import { zodSchema } from 'ai';
import type { GenerateOptions } from '../providers/llm';
import { estimateTokens } from '../models/estimateTokens';
import { getModelInfo } from '../models/registry';
import { schemaToJsonSchema } from '../utils/zodCompat';

/** Context window assumed for a model the registry does not know. */
const FALLBACK_CONTEXT_WINDOW = 128_000;

/** `feature:model` pairs already warned about (one console.warn each per process). */
const warned = new Set<string>();

/**
 * `explicit`, else the registry's window for `model`, else
 * {@link FALLBACK_CONTEXT_WINDOW} with a one-time `console.warn` naming
 * `setting` (the option that sets it) and `registerModel()`.
 */
export function resolveContextWindow(explicit: number | undefined, model: string | undefined, feature: string, setting: string): number {
  if (explicit !== undefined) return explicit;
  const known = model ? getModelInfo(model)?.contextWindow : undefined;
  if (known !== undefined) return known;
  const key = `${feature}:${model ?? ''}`;
  if (!warned.has(key)) {
    warned.add(key);
    const what = model ? `Model '${model}' is not in the model registry` : 'The model of this run is not known';
    console.warn(
      `[lousho] ${what}, so ${feature} assumes a ${FALLBACK_CONTEXT_WINDOW.toLocaleString('en-US')}-token context window. ` +
        `If the real window is smaller (a local model: LM Studio's loaded context length, Ollama's num_ctx), set '${setting}' ` +
        `or call registerModel({ id: '${model ?? '<model id>'}', provider: '<provider>', contextWindow: <tokens> }). See docs/compaction.md.`
    );
  }
  return FALLBACK_CONTEXT_WINDOW;
}

/** Estimated tokens per tool schema object, so a run's unchanged tools are converted once. */
const schemaTokens = new WeakMap<object, number>();

function jsonSchemaOf(parameters: unknown): unknown {
  try {
    return schemaToJsonSchema(parameters) ?? zodSchema(parameters as never).jsonSchema;
  } catch {
    return parameters ?? {};
  }
}

/**
 * The estimated tokens a request sends besides its messages: the function
 * tool definitions (name, description, JSON Schema) and the output schema.
 * The system prompt is a message, so `estimateTokens(messages)` counts it.
 */
export function requestOverheadTokens(request: GenerateOptions): number {
  let tokens = 0;
  for (const { function: fn } of request.tools ?? []) {
    const params = fn.parameters as object | undefined;
    let schema = params ? schemaTokens.get(params) : undefined;
    if (schema === undefined) {
      schema = estimateTokens(JSON.stringify(jsonSchemaOf(params)) ?? '', { model: request.model });
      if (params) schemaTokens.set(params, schema);
    }
    tokens += schema + estimateTokens(`${fn.name} ${fn.description ?? ''}`, { model: request.model });
  }
  if (request.responseFormat?.schema) tokens += estimateTokens(JSON.stringify(request.responseFormat.schema), { model: request.model });
  return tokens;
}
