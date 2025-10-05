import { describe, it, expect } from 'vitest';
import { convertToFlowDefinition, convertFromFlowDefinition } from './converters';
import { EditorStep } from '../types';

describe('Flow Converters', () => {
  describe('convertToFlowDefinition', () => {
    it('should convert simple step', () => {
      const step: EditorStep = {
        type: 'step',
        agent: 'testAgent',
        input: 'test input',
      };

      const result = convertToFlowDefinition(step);

      expect(result.agent).toBe('testAgent');
      expect(result.input).toBe('test input');
      expect(result.id).toBeDefined();
    });

    it('should convert sequence', () => {
      const step: EditorStep = {
        type: 'sequence',
        steps: [
          { type: 'step', agent: 'agent1', input: 'step 1' },
          { type: 'step', agent: 'agent2', input: 'step 2' },
        ],
      };

      const result = convertToFlowDefinition(step);

      expect(result.agent).toBe('sequenceAgent');
      expect(Array.isArray(result.input)).toBe(true);
      expect(result.input).toHaveLength(2);
      expect(result.input[0].agent).toBe('agent1');
      expect(result.input[1].agent).toBe('agent2');
    });

    it('should convert parallel', () => {
      const step: EditorStep = {
        type: 'parallel',
        steps: [
          { type: 'step', agent: 'agent1', input: 'step 1' },
          { type: 'step', agent: 'agent2', input: 'step 2' },
        ],
      };

      const result = convertToFlowDefinition(step);

      expect(result.agent).toBe('parallelAgent');
      expect(Array.isArray(result.input)).toBe(true);
      expect(result.input).toHaveLength(2);
    });

    it('should convert oneOf', () => {
      const step: EditorStep = {
        type: 'oneOf',
        branches: [
          { when: 'condition1', flow: { type: 'step', agent: 'agent1', input: 'flow 1' } },
          { when: 'condition2', flow: { type: 'step', agent: 'agent2', input: 'flow 2' } },
        ],
      };

      const result = convertToFlowDefinition(step);

      expect(result.agent).toBe('oneOfAgent');
      expect(result.conditions).toEqual(['condition1', 'condition2']);
      expect(Array.isArray(result.input)).toBe(true);
      expect(result.input).toHaveLength(2);
    });

    it('should convert forEach', () => {
      const step: EditorStep = {
        type: 'forEach',
        item: 'user',
        inputFlow: { type: 'step', agent: 'processUser', input: 'process @user' },
      };

      const result = convertToFlowDefinition(step);

      expect(result.agent).toBe('forEachAgent');
      expect(result.item).toBe('user');
      expect(result.input.agent).toBe('processUser');
    });

    it('should convert evaluator', () => {
      const step: EditorStep = {
        type: 'evaluator',
        criteria: 'quality > 0.8',
        max_iterations: 3,
        subFlow: { type: 'step', agent: 'improve', input: 'improve quality' },
      };

      const result = convertToFlowDefinition(step);

      expect(result.agent).toBe('optimizeAgent');
      expect(result.criteria).toBe('quality > 0.8');
      expect(result.max_iterations).toBe(3);
      expect(result.input.agent).toBe('improve');
    });

    it('should convert bestOfAll', () => {
      const step: EditorStep = {
        type: 'bestOfAll',
        criteria: 'highest score',
        steps: [
          { type: 'step', agent: 'approach1', input: 'method 1' },
          { type: 'step', agent: 'approach2', input: 'method 2' },
        ],
      };

      const result = convertToFlowDefinition(step);

      expect(result.agent).toBe('bestOfAllAgent');
      expect(result.criteria).toBe('highest score');
      expect(result.input).toHaveLength(2);
    });

    it('should convert tool', () => {
      const step: EditorStep = {
        type: 'tool',
        toolName: 'httpTool',
        toolOptions: { url: 'https://api.example.com' },
      };

      const result = convertToFlowDefinition(step);

      expect(result.agent).toBe('toolAgent');
      const parsed = JSON.parse(result.input);
      expect(parsed.toolName).toBe('httpTool');
      expect(parsed.toolOptions.url).toBe('https://api.example.com');
    });

    it('should convert condition', () => {
      const step: EditorStep = {
        type: 'condition',
        condition: 'x > 5',
        trueFlow: { type: 'step', agent: 'ifTrue', input: 'true branch' },
        falseFlow: { type: 'step', agent: 'ifFalse', input: 'false branch' },
      };

      const result = convertToFlowDefinition(step);

      expect(result.agent).toBe('oneOfAgent');
      expect(result.conditions).toEqual(['x > 5', '!(x > 5)']);
      expect(result.input).toHaveLength(2);
    });

    it('should handle nested structures', () => {
      const step: EditorStep = {
        type: 'sequence',
        steps: [
          {
            type: 'parallel',
            steps: [
              { type: 'step', agent: 'agent1', input: 'parallel 1' },
              { type: 'step', agent: 'agent2', input: 'parallel 2' },
            ],
          },
          { type: 'step', agent: 'agent3', input: 'after parallel' },
        ],
      };

      const result = convertToFlowDefinition(step);

      expect(result.agent).toBe('sequenceAgent');
      expect(result.input[0].agent).toBe('parallelAgent');
      expect(result.input[1].agent).toBe('agent3');
    });
  });

  describe('convertFromFlowDefinition', () => {
    it('should convert back to step', () => {
      const flowDef = {
        id: 'test-id',
        agent: 'testAgent',
        input: 'test input',
      };

      const result = convertFromFlowDefinition(flowDef);

      expect(result.type).toBe('step');
      if (result.type === 'step') {
        expect(result.agent).toBe('testAgent');
        expect(result.input).toBe('test input');
      }
    });

    it('should convert back to sequence', () => {
      const flowDef = {
        id: 'seq-id',
        agent: 'sequenceAgent',
        input: [
          { id: 'step1', agent: 'agent1', input: 'step 1' },
          { id: 'step2', agent: 'agent2', input: 'step 2' },
        ],
      };

      const result = convertFromFlowDefinition(flowDef);

      expect(result.type).toBe('sequence');
      if (result.type === 'sequence') {
        expect(result.steps).toHaveLength(2);
      }
    });

    it('should convert back to oneOf', () => {
      const flowDef = {
        id: 'oneof-id',
        agent: 'oneOfAgent',
        input: [
          { id: 'flow1', agent: 'agent1', input: 'flow 1' },
          { id: 'flow2', agent: 'agent2', input: 'flow 2' },
        ],
        conditions: ['cond1', 'cond2'],
      };

      const result = convertFromFlowDefinition(flowDef);

      expect(result.type).toBe('oneOf');
      if (result.type === 'oneOf') {
        expect(result.branches).toHaveLength(2);
        expect(result.branches[0].when).toBe('cond1');
      }
    });

    it('should round-trip correctly', () => {
      const original: EditorStep = {
        type: 'sequence',
        steps: [
          { type: 'step', agent: 'agent1', input: 'step 1' },
          {
            type: 'parallel',
            steps: [
              { type: 'step', agent: 'agent2', input: 'step 2' },
              { type: 'step', agent: 'agent3', input: 'step 3' },
            ],
          },
        ],
      };

      const flowDef = convertToFlowDefinition(original);
      const backToEditor = convertFromFlowDefinition(flowDef);

      expect(backToEditor.type).toBe('sequence');
      if (backToEditor.type === 'sequence') {
        expect(backToEditor.steps).toHaveLength(2);
        expect(backToEditor.steps[1].type).toBe('parallel');
      }
    });
  });
});
