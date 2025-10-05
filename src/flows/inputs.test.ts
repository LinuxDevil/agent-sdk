import { describe, it, expect } from 'vitest';
import {
  extractVariableNames,
  replaceVariablesInString,
  injectVariables,
  createDynamicZodSchemaForInputs,
  validateFlowInput,
} from './inputs';

describe('Flow Inputs', () => {
  describe('extractVariableNames', () => {
    it('should extract single variable', () => {
      const names = extractVariableNames('Hello @name');
      expect(names).toEqual(['name']);
    });

    it('should extract multiple variables', () => {
      const names = extractVariableNames('Hello @firstName @lastName');
      expect(names).toEqual(['firstName', 'lastName']);
    });

    it('should return empty array when no variables', () => {
      const names = extractVariableNames('Hello world');
      expect(names).toEqual([]);
    });

    it('should handle variables with underscores and numbers', () => {
      const names = extractVariableNames('@user_id_123 @email_2');
      expect(names).toEqual(['user_id_123', 'email_2']);
    });
  });

  describe('replaceVariablesInString', () => {
    it('should replace single variable', () => {
      const result = replaceVariablesInString(
        'Hello @name',
        { name: 'John' }
      );
      expect(result).toBe('Hello John');
    });

    it('should replace multiple variables', () => {
      const result = replaceVariablesInString(
        'Hello @firstName @lastName',
        { firstName: 'John', lastName: 'Doe' }
      );
      expect(result).toBe('Hello John Doe');
    });

    it('should replace multiple occurrences of same variable', () => {
      const result = replaceVariablesInString(
        '@name said hello to @name',
        { name: 'Alice' }
      );
      expect(result).toBe('Alice said hello to Alice');
    });

    it('should handle missing variables', () => {
      const result = replaceVariablesInString(
        'Hello @name',
        {}
      );
      expect(result).toBe('Hello @name');
    });
  });

  describe('injectVariables', () => {
    it('should inject variables into simple flow', () => {
      const flowDef = {
        agent: 'testAgent',
        input: 'Process @email',
      };

      const result = injectVariables(flowDef, { email: 'test@example.com' });

      expect(result.input).toBe('Process test@example.com');
    });

    it('should inject variables into conditions', () => {
      const flowDef = {
        agent: 'oneOfAgent',
        input: [],
        conditions: ['@value > 10', '@value < 5'],
      };

      const result = injectVariables(flowDef, { value: 'x' });

      expect(result.conditions).toEqual(['x > 10', 'x < 5']);
    });

    it('should inject variables into criteria', () => {
      const flowDef = {
        agent: 'optimizeAgent',
        criteria: 'quality of @product > 0.8',
        input: {},
      };

      const result = injectVariables(flowDef, { product: 'widget' });

      expect(result.criteria).toBe('quality of widget > 0.8');
    });

    it('should inject variables recursively', () => {
      const flowDef = {
        agent: 'sequenceAgent',
        input: [
          { agent: 'agent1', input: 'Process @item1' },
          { agent: 'agent2', input: 'Process @item2' },
        ],
      };

      const result = injectVariables(flowDef, { item1: 'A', item2: 'B' });

      expect(result.input[0].input).toBe('Process A');
      expect(result.input[1].input).toBe('Process B');
    });
  });

  describe('createDynamicZodSchemaForInputs', () => {
    it('should create schema for text inputs', () => {
      const schema = createDynamicZodSchemaForInputs({
        availableInputs: [
          { name: 'email', type: 'shortText', required: true },
          { name: 'message', type: 'longText', required: false },
        ],
      });

      const valid = schema.safeParse({ email: 'test@example.com', message: 'Hello' });
      expect(valid.success).toBe(true);
    });

    it('should create schema for number inputs', () => {
      const schema = createDynamicZodSchemaForInputs({
        availableInputs: [
          { name: 'age', type: 'number', required: true },
        ],
      });

      const valid = schema.safeParse({ age: 25 });
      expect(valid.success).toBe(true);

      const invalid = schema.safeParse({ age: 'twenty-five' });
      expect(invalid.success).toBe(false);
    });

    it('should handle optional inputs', () => {
      const schema = createDynamicZodSchemaForInputs({
        availableInputs: [
          { name: 'optional', type: 'shortText', required: false },
        ],
      });

      const validWithout = schema.safeParse({});
      expect(validWithout.success).toBe(true);

      const validWith = schema.safeParse({ optional: 'value' });
      expect(validWith.success).toBe(true);
    });

    it('should create empty schema for no inputs', () => {
      const schema = createDynamicZodSchemaForInputs({
        availableInputs: [],
      });

      const valid = schema.safeParse({});
      expect(valid.success).toBe(true);
    });
  });

  describe('validateFlowInput', () => {
    it('should validate required inputs', () => {
      const result = validateFlowInput(
        { email: 'test@example.com' },
        [{ name: 'email', type: 'shortText', required: true }]
      );

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should detect missing required inputs', () => {
      const result = validateFlowInput(
        {},
        [{ name: 'email', type: 'shortText', required: true }]
      );

      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Required input variable 'email' is missing");
    });

    it('should validate input types', () => {
      const result = validateFlowInput(
        { age: 'twenty-five' },
        [{ name: 'age', type: 'number', required: true }]
      );

      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Input variable 'age' must be a number");
    });

    it('should allow optional missing inputs', () => {
      const result = validateFlowInput(
        {},
        [{ name: 'optional', type: 'shortText', required: false }]
      );

      expect(result.valid).toBe(true);
    });

    it('should validate multiple inputs', () => {
      const result = validateFlowInput(
        { email: 'test@example.com', age: 25 },
        [
          { name: 'email', type: 'shortText', required: true },
          { name: 'age', type: 'number', required: true },
        ]
      );

      expect(result.valid).toBe(true);
    });
  });
});
