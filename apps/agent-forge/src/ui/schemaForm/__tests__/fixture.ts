import type { JsonSchema } from '../types';

/** The schema every schemaForm test shares: one property per supported field kind plus a `$ref`. */
export const SCHEMA: JsonSchema = {
  type: 'object',
  required: ['name', 'model'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 64, description: 'Shown on the card.' },
    model: { type: 'string', title: 'Model' },
    reasoning: { enum: ['off', 'low', 'medium', 'high'] },
    maxSteps: { type: 'integer', minimum: 1, maximum: 100, default: 12 },
    askQuestion: { type: 'boolean', default: false },
    fallbackModels: { type: 'array', items: { type: 'string' } },
    modelSettings: { $ref: '#/definitions/settings' },
    output: { type: 'object' },
  },
  definitions: {
    settings: {
      type: 'object',
      properties: { temperature: { type: 'number', minimum: 0, maximum: 2 } },
    },
  },
};

/** A ToolRef-shaped `anyOf`: each option discriminated by one unique required key. */
export const TOOL_REF: JsonSchema = {
  anyOf: [
    {
      type: 'object',
      required: ['builtin'],
      properties: {
        builtin: { type: 'string' },
        id: { type: 'string' },
        approval: { enum: ['always', 'never', 'auto'] },
      },
    },
    {
      type: 'object',
      required: ['registry'],
      properties: {
        registry: { type: 'string' },
        version: { type: 'string' },
        id: { type: 'string' },
      },
    },
    {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string' }, id: { type: 'string' } },
    },
  ],
};

/** A TriggerSpec-shaped `oneOf`: discriminated by a `const` on the shared `type` key. */
export const TRIGGER: JsonSchema = {
  oneOf: [
    {
      type: 'object',
      required: ['id', 'type'],
      properties: { id: { type: 'string' }, type: { const: 'chat' } },
    },
    {
      type: 'object',
      required: ['id', 'type', 'cron', 'prompt'],
      properties: {
        id: { type: 'string' },
        type: { const: 'cron' },
        cron: { type: 'string' },
        prompt: { type: 'string' },
      },
    },
  ],
};

/** U14 fixture: a union array, a record map and a nullable string on top of the union shapes. */
export const SPEC: JsonSchema = {
  type: 'object',
  properties: {
    tools: { type: 'array', items: TOOL_REF },
    triggers: { type: 'array', items: TRIGGER },
    instructionsByFamily: { type: 'object', additionalProperties: { type: 'string' } },
    nullableName: { anyOf: [{ type: 'string' }, { type: 'null' }] },
  },
};
