import { describe, it, expect } from 'vitest';
import { validateFlow, validateAgentDefinition } from './validators';

describe('Flow Validators', () => {
  describe('validateFlow', () => {
    it('should validate complete flow', () => {
      const result = validateFlow({
        code: 'test-flow',
        name: 'Test Flow',
        description: 'A test flow',
        inputs: [{ name: 'email', type: 'shortText', required: true }],
        agents: [
          { name: 'agent1', model: 'gpt-4', system: 'You are agent 1', tools: [] },
        ],
      });

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should detect missing code', () => {
      const result = validateFlow({
        name: 'Test Flow',
      });

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Flow code is required');
    });

    it('should detect missing name', () => {
      const result = validateFlow({
        code: 'test-flow',
      });

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Flow name is required');
    });

    it('should detect duplicate input names', () => {
      const result = validateFlow({
        code: 'test',
        name: 'Test',
        inputs: [
          { name: 'email', type: 'shortText', required: true },
          { name: 'email', type: 'number', required: false },
        ],
      });

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Duplicate input variable name: email');
    });

    it('should detect input without name', () => {
      const result = validateFlow({
        code: 'test',
        name: 'Test',
        inputs: [
          { name: '', type: 'shortText', required: true },
        ],
      });

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Input variable name is required');
    });

    it('should detect input without type', () => {
      const result = validateFlow({
        code: 'test',
        name: 'Test',
        inputs: [
          { name: 'test', type: undefined as any, required: true },
        ],
      });

      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('must have a type');
    });

    it('should detect duplicate agent names', () => {
      const result = validateFlow({
        code: 'test',
        name: 'Test',
        agents: [
          { name: 'agent1', model: 'gpt-4', system: 'Agent 1', tools: [] },
          { name: 'agent1', model: 'gpt-4', system: 'Agent 1 duplicate', tools: [] },
        ],
      });

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Duplicate agent name: agent1');
    });

    it('should detect agent without name', () => {
      const result = validateFlow({
        code: 'test',
        name: 'Test',
        agents: [
          { name: '', model: 'gpt-4', system: 'Test', tools: [] },
        ],
      });

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Agent name is required');
    });

    it('should detect agent without model', () => {
      const result = validateFlow({
        code: 'test',
        name: 'Test',
        agents: [
          { name: 'agent1', model: '', system: 'Test', tools: [] },
        ],
      });

      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('must have a model');
    });

    it('should detect agent without system prompt', () => {
      const result = validateFlow({
        code: 'test',
        name: 'Test',
        agents: [
          { name: 'agent1', model: 'gpt-4', system: '', tools: [] },
        ],
      });

      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('must have a system prompt');
    });
  });

  describe('validateAgentDefinition', () => {
    it('should validate complete agent', () => {
      const result = validateAgentDefinition({
        name: 'testAgent',
        model: 'gpt-4',
        system: 'You are a test agent',
        tools: [],
      });

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should detect missing name', () => {
      const result = validateAgentDefinition({
        model: 'gpt-4',
        system: 'Test',
      });

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Agent name is required');
    });

    it('should detect missing model', () => {
      const result = validateAgentDefinition({
        name: 'test',
        system: 'Test',
      });

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Agent model is required');
    });

    it('should detect missing system prompt', () => {
      const result = validateAgentDefinition({
        name: 'test',
        model: 'gpt-4',
      });

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Agent system prompt is required');
    });
  });
});
