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
