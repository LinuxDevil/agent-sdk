/**
 * The JSON Schema (draft-07) subset the schema form understands. Mirrors the
 * shapes emitted by the SDK catalogs (`agentSpecV2JsonSchema`,
 * `listGuardrails().optionsJsonSchema`, `listTriggerTypes().fieldsJsonSchema`).
 */
export interface JsonSchema {
  $ref?: string;
  type?: string | string[];
  title?: string;
  description?: string;
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  examples?: unknown[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  minItems?: number;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  definitions?: Record<string, JsonSchema>;
  $defs?: Record<string, JsonSchema>;
  'x-widget'?: 'textarea' | 'secret' | 'code';
}

/** A path into the form value: property keys and array indices. */
export type SchemaPath = (string | number)[];

/** One validation complaint; `path` is the {@link pathKey} of the offending value. */
export interface SchemaIssue {
  path: string;
  message: string;
}
