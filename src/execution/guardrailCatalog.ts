/**
 * The guardrail catalog (`listGuardrails()`): the starter-set guardrails a
 * spec can name, each with a description, the sides it can run on and its
 * options as a JSON Schema, so a builder UI can render a form per guardrail
 * without knowing the built-ins by name.
 */
import { zodSchema } from 'ai';
import { GUARDRAIL_OPTIONS, SPEC_GUARDRAIL_NAMES, type SpecGuardrailName } from '../spec/guardrailOptions';
import { REWRITABLE_GUARDRAILS, type GuardrailSide } from '../spec/v2/guardrails';
import { schemaToJsonSchema } from '../utils/zodCompat';

/** One {@link listGuardrails} entry: a starter-set guardrail and the JSON Schema of its options. */
export interface GuardrailCatalogEntry {
  /** The `guardrails[].name` value a spec writes. */
  name: SpecGuardrailName;
  /** One sentence: what the guardrail checks, for the picker's list row. */
  description: string;
  /** Every side a built-in can run on; a spec picks with `on` (default input and output). */
  on: GuardrailSide[];
  /** GUARDRAIL_OPTIONS[name] as JSON Schema, without `on` (a spec-level key, not an option). */
  optionsJsonSchema: Record<string, unknown>;
  /** Whether the guardrail's options take `action: 'rewrite'`. */
  canRewrite: boolean;
  /** Whether it can check the input while the first model call is in flight (input side only). */
  canRunInParallel: boolean;
}

/** What each built-in does, in the words the catalog and the inspector form show. */
const DESCRIPTIONS: Record<SpecGuardrailName, string> = {
  'max-length': 'Blocks text longer than a set number of characters.',
  'secret-scan': 'Finds API keys and tokens in the text; blocks or masks them.',
  regex: 'Blocks or rewrites text that matches a regular expression you give.',
  'deny-topics': 'Blocks text that mentions any of the topics you list.',
  'llm-judge': 'Asks a model whether the text is acceptable, using your instruction.',
  pii: 'Finds personal data (emails, phone numbers, card numbers, ...); blocks or masks it.',
  secrets: 'Finds secrets with the built-in patterns plus yours; masks them by default.',
  'prompt-injection': "Flags attempts to override the agent's instructions (heuristics, then a model if set).",
  moderation: 'Asks a model to flag hateful, violent, sexual or other harmful content.',
};

/** The named built-in's options schema as JSON Schema, without `on`. Fresh on every call. */
function optionsJsonSchemaOf(name: SpecGuardrailName): Record<string, unknown> {
  const schema = GUARDRAIL_OPTIONS[name];
  const json = schemaToJsonSchema(schema) ?? (zodSchema(schema as never).jsonSchema as Record<string, unknown>);
  delete (json.properties as Record<string, unknown> | undefined)?.on;
  if (Array.isArray(json.required)) {
    json.required = (json.required as unknown[]).filter((key) => key !== 'on');
  }
  return json;
}

/** The starter-set guardrails a spec can name, in SPEC_GUARDRAIL_NAMES order. Fresh objects on every call. */
export function listGuardrails(): GuardrailCatalogEntry[] {
  return SPEC_GUARDRAIL_NAMES.map((name) => ({
    name,
    description: DESCRIPTIONS[name],
    on: ['input', 'output', 'tools'],
    optionsJsonSchema: optionsJsonSchemaOf(name),
    canRewrite: REWRITABLE_GUARDRAILS.includes(name),
    canRunInParallel: true,
  }));
}
