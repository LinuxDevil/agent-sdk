import { describe, it, expect } from 'vitest';
import { FlowBuilder } from './FlowBuilder';

describe('FlowBuilder', () => {
  describe('basic building', () => {
    it('should build a simple flow', () => {
      const flow = new FlowBuilder()
        .setCode('test-flow')
        .setName('Test Flow')
        .setDescription('A test flow')
        .build();

      expect(flow.code).toBe('test-flow');
      expect(flow.name).toBe('Test Flow');
      expect(flow.description).toBe('A test flow');
      expect(flow.id).toBeDefined();
      expect(flow.inputs).toEqual([]);
      expect(flow.agents).toEqual([]);
    });

    it('should throw error when code is missing', () => {
      expect(() => {
        new FlowBuilder().setName('Test').build();
      }).toThrow('Flow code is required');
    });

    it('should throw error when name is missing', () => {
      expect(() => {
        new FlowBuilder().setCode('test').build();
      }).toThrow('Flow name is required');
    });

    it('should set custom ID', () => {
      const customId = 'custom-flow-id';
      const flow = new FlowBuilder()
        .setCode('test')
        .setName('Test')
        .setId(customId)
        .build();

      expect(flow.id).toBe(customId);
    });
  });

  describe('input management', () => {
    it('should add single input', () => {
      const flow = new FlowBuilder()
        .setCode('test')
        .setName('Test')
        .addInput({
          name: 'email',
          type: 'shortText',
          required: true,
        })
        .build();

      expect(flow.inputs).toHaveLength(1);
      expect(flow.inputs![0].name).toBe('email');
      expect(flow.inputs![0].type).toBe('shortText');
    });

    it('should add multiple inputs', () => {
      const flow = new FlowBuilder()
        .setCode('test')
        .setName('Test')
        .addInput({ name: 'email', type: 'shortText', required: true })
        .addInput({ name: 'age', type: 'number', required: false })
        .build();

      expect(flow.inputs).toHaveLength(2);
    });

    it('should set all inputs at once', () => {
      const inputs = [
        { name: 'email', type: 'shortText' as const, required: true },
        { name: 'age', type: 'number' as const, required: false },
      ];

      const flow = new FlowBuilder()
        .setCode('test')
        .setName('Test')
        .setInputs(inputs)
        .build();

      expect(flow.inputs).toEqual(inputs);
    });

    it('should throw error for duplicate input names', () => {
      expect(() => {
        new FlowBuilder()
          .setCode('test')
          .setName('Test')
          .addInput({ name: 'email', type: 'shortText', required: true })
          .addInput({ name: 'email', type: 'number', required: false })
          .build();
      }).toThrow('Duplicate input variable name: email');
    });

    it('should throw error for input without name', () => {
      expect(() => {
        new FlowBuilder()
          .setCode('test')
          .setName('Test')
          .addInput({ name: '', type: 'shortText', required: true })
          .build();
      }).toThrow('Input variable name is required');
    });
  });

  describe('flow definition', () => {
    it('should set flow definition', () => {
      const flowDef = {
        type: 'step' as const,
        agent: 'testAgent',
        input: 'test input',
      };

      const flow = new FlowBuilder()
        .setCode('test')
        .setName('Test')
        .setFlow(flowDef)
        .build();

      expect(flow.flow).toEqual(flowDef);
    });

    it('should set complex flow definition', () => {
      const flowDef = {
        type: 'sequence' as const,
        steps: [
          { type: 'step' as const, agent: 'agent1', input: 'step 1' },
          { type: 'step' as const, agent: 'agent2', input: 'step 2' },
        ],
      };

      const flow = new FlowBuilder()
        .setCode('test')
        .setName('Test')
        .setFlow(flowDef)
        .build();

      expect(flow.flow).toEqual(flowDef);
    });
  });

  describe('agent management', () => {
    it('should add single agent', () => {
      const agent = {
        name: 'testAgent',
        model: 'gpt-4',
        system: 'You are a test agent',
        tools: [],
      };

      const flow = new FlowBuilder()
        .setCode('test')
        .setName('Test')
        .addAgent(agent)
        .build();

      expect(flow.agents).toHaveLength(1);
      expect(flow.agents![0]).toEqual(agent);
    });

    it('should add multiple agents', () => {
      const flow = new FlowBuilder()
        .setCode('test')
        .setName('Test')
        .addAgent({ name: 'agent1', model: 'gpt-4', system: 'Agent 1', tools: [] })
        .addAgent({ name: 'agent2', model: 'gpt-4', system: 'Agent 2', tools: [] })
        .build();

      expect(flow.agents).toHaveLength(2);
    });

    it('should set all agents at once', () => {
      const agents = [
        { name: 'agent1', model: 'gpt-4', system: 'Agent 1', tools: [] },
        { name: 'agent2', model: 'gpt-4', system: 'Agent 2', tools: [] },
      ];

      const flow = new FlowBuilder()
        .setCode('test')
        .setName('Test')
        .setAgents(agents)
        .build();

      expect(flow.agents).toEqual(agents);
    });
  });

  describe('static methods', () => {
    it('should create from existing flow', () => {
      const existingFlow = {
        id: 'existing-id',
        code: 'existing-code',
        name: 'Existing Flow',
        description: 'Description',
        inputs: [{ name: 'test', type: 'shortText' as const, required: true }],
        flow: { type: 'step' as const, agent: 'test', input: 'test' },
        agents: [],
      };

      const flow = FlowBuilder.from(existingFlow).build();

      expect(flow.id).toBe('existing-id');
      expect(flow.code).toBe('existing-code');
      expect(flow.name).toBe('Existing Flow');
    });

    it('should create new instance with create()', () => {
      const builder = FlowBuilder.create();
      expect(builder).toBeInstanceOf(FlowBuilder);
    });
  });

  describe('fluent API chaining', () => {
    it('should chain all methods', () => {
      const flow = FlowBuilder.create()
        .setCode('chained')
        .setName('Chained Flow')
        .setDescription('Testing method chaining')
        .addInput({ name: 'input1', type: 'shortText', required: true })
        .addInput({ name: 'input2', type: 'number', required: false })
        .setFlow({ type: 'step', agent: 'test', input: 'test' })
        .addAgent({ name: 'agent1', model: 'gpt-4', system: 'Test', tools: [] })
        .build();

      expect(flow.code).toBe('chained');
      expect(flow.name).toBe('Chained Flow');
      expect(flow.inputs).toHaveLength(2);
      expect(flow.agents).toHaveLength(1);
      expect(flow.flow).toBeDefined();
    });
  });
});
