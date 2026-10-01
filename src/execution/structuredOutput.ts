/**
 * Structured output (LOU-V4): what a run with `ExecuteOptions.output` adds
 * to the request (an instruction in the system prompt and a
 * `responseFormat` hint), and the parse/validate/repair of its final reply.
 */

import { zodSchema } from 'ai';
import type { GenerateOptions, Message } from '../providers';
import { formatIssues, parseWithIssues, type ToolArgumentIssue } from './toolArgsValidation';
import { schemaToJsonSchema, type StandardSchemaV1 } from '../utils/zodCompat';

/** Why a run's final reply is not a valid `output` object (`finishReason: 'output-invalid'`). */
export interface OutputError {
  /** Model-readable summary, e.g. `The reply does not match the output schema: 1 issue (city: Required)`. */
  message: string;
  /** Each problem with its path (`(root)` for the whole reply). */
  issues: ToolArgumentIssue[];
}

const jsonSchemas = new WeakMap<StandardSchemaV1, Record<string, unknown>>();

/**
 * The schema as JSON Schema, computed once per schema: `z.toJSONSchema` for
 * zod 4 (LOU-D29), the `ai` SDK's zod converter for zod 3.
 */
function jsonSchemaOf(schema: StandardSchemaV1): Record<string, unknown> {
  let json = jsonSchemas.get(schema);
  if (!json) {
    json = schemaToJsonSchema(schema) ?? (zodSchema(schema as never).jsonSchema as Record<string, unknown>);
    jsonSchemas.set(schema, json);
  }
  return json;
}

/** The system-prompt block that asks for the final answer as JSON matching `schema`. */
export function outputInstruction(schema: StandardSchemaV1): string {
  return [
    '## Output format',
    '',
    'You may call tools first. Your final answer must be only a JSON object (no other text, no code fences) that matches this JSON Schema:',
    '',
    JSON.stringify(jsonSchemaOf(schema)),
  ].join('\n');
}

/** The `responseFormat` hint sent with every model call of the run. */
export function outputResponseFormat(schema: StandardSchemaV1): GenerateOptions['responseFormat'] {
  return { type: 'json', schema: jsonSchemaOf(schema) };
}

/** `text` without surrounding whitespace and a ```/```json code fence. */
function unfence(text: string): string {
  const trimmed = text.trim();
  return /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed)?.[1] ?? trimmed;
}

/** Parses the final reply as JSON and validates it with `schema`. */
export async function validateOutput(
  schema: StandardSchemaV1,
  text: string
): Promise<{ object: unknown } | { outputError: OutputError }> {
  let value: unknown;
  try {
    value = JSON.parse(unfence(text));
  } catch (error) {
    const issues = [{ path: '(root)', message: `Not valid JSON: ${(error as Error).message}` }];
    return { outputError: { message: `The reply is not a JSON object: ${formatIssues(issues)}`, issues } };
  }
  const result = await parseWithIssues(schema, value);
  if (result.success) return { object: result.data };
  const message = `The reply does not match the output schema: ${formatIssues(result.issues)}`;
  return { outputError: { message, issues: result.issues } };
}

/** The user message of the one repair step: the issues, and the ask to answer again. */
export function outputRepairMessage(error: OutputError): Message {
  return {
    role: 'user',
    content: `[output-invalid] ${error.message}. Reply again with only the corrected JSON object.`,
  };
}
