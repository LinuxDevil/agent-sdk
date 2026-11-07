import { describe, it, expect } from 'vitest';
import { ValidationError } from '../../execution/errors';
import { FlowExecutor } from '../../flows/FlowExecutor';
import { EXECUTABLE_TYPES, flowProblems, flowSpecSchema } from './flow';
import { parseAgentSpecV2 } from './parse';

const base = { version: 2, name: 'support', model: 'anthropic/claude-sonnet-5-5', instructions: 'Help.' };

function problems(flow: unknown, agentNames: readonly string[] = ['billing']) {
  return flowProblems(flow, { agentNames });
}

function thrown(data: unknown): ValidationError {
  try {
    parseAgentSpecV2(data);
  } catch (error) {
    if (error instanceof ValidationError) return error;
    throw error;
  }
  throw new Error('expected parseAgentSpecV2 to throw');
}

/** The ticket's valid example: sequence of agent('self'), approval, end. */
const VALID_FLOW = {
  code: 'f',
  name: 'F',
  flow: {
    type: 'sequence',
    id: 's',
    steps: [
      { type: 'agent', id: 'a', agent: 'self' },
      { type: 'approval', id: 'ok', message: 'Ship?' },
      { type: 'end', id: 'e' },
    ],
  },
};

describe('flowProblems', () => {
  it('returns nothing for a flow the runner can execute', () => {
    expect(problems(VALID_FLOW)).toEqual([]);
  });

  it('reuses validateFlow for a missing code and name, at the flow key', () => {
    expect(problems({ flow: { type: 'end', id: 'e' } })).toEqual([
      { path: ['flow'], message: 'Flow code is required', unsupported: false },
      { path: ['flow'], message: 'Flow name is required', unsupported: false },
    ]);
  });

  it('reports a missing first step', () => {
    expect(problems({ code: 'f', name: 'F' })).toEqual([
      { path: ['flow', 'flow'], message: 'the flow needs a first step', unsupported: false },
    ]);
  });

  it.each(['step', 'bestOfAll', 'tool', 'uiComponent', 'condition', 'loop'])(
    "flags editor-only type '%s' as unsupported",
    (type) => {
      expect(problems({ ...VALID_FLOW, flow: { type, id: 'x' } })).toEqual([
        { path: ['flow', 'flow'], message: `'${type}' steps are an editor shape the flow runner cannot run`, unsupported: true },
      ]);
    }
  );

  it("flags a oneOf with 'branches' as an editor-only shape", () => {
    const step = { type: 'oneOf', id: 'o', branches: [{ when: 'x', flow: { type: 'end', id: 'e' } }] };
    expect(problems({ ...VALID_FLOW, flow: step })).toEqual([
      { path: ['flow', 'flow'], message: "this 'oneOf' shape is editor-only; use 'options'", unsupported: true },
    ]);
  });

  it("flags a forEach with 'inputFlow' as an editor-only shape", () => {
    const step = { type: 'forEach', id: 'f', item: 'x', inputFlow: { type: 'end', id: 'e' } };
    expect(problems({ ...VALID_FLOW, flow: step })).toEqual([
      { path: ['flow', 'flow'], message: "this 'forEach' shape is editor-only; use 'items' and 'step'", unsupported: true },
    ]);
  });

  it("flags an evaluator with 'criteria' as an editor-only shape", () => {
    const step = { type: 'evaluator', id: 'v', criteria: 'x', subFlow: { type: 'end', id: 'e' } };
    expect(problems({ ...VALID_FLOW, flow: step })).toEqual([
      { path: ['flow', 'flow'], message: "this 'evaluator' shape is editor-only; use 'expression'", unsupported: true },
    ]);
  });

  it('flags an unknown step type as invalid, not unsupported', () => {
    expect(problems({ ...VALID_FLOW, flow: { type: 'wait', id: 'w' } })).toEqual([
      { path: ['flow', 'flow'], message: "unknown step type 'wait'", unsupported: false },
    ]);
  });

  it.each([undefined, 5, '', null])('reports a step id that is %s', (id) => {
    expect(problems({ ...VALID_FLOW, flow: { type: 'end', id } })).toEqual([
      { path: ['flow', 'flow', 'id'], message: 'every flow step needs an id', unsupported: false },
    ]);
  });

  it('reports a duplicate id once, at the second occurrence', () => {
    const flow = {
      code: 'f',
      name: 'F',
      flow: {
        type: 'sequence',
        id: 's',
        steps: [
          { type: 'sequence', id: 'inner', steps: [{ type: 'end', id: 'x' }] },
          { type: 'end', id: 'mid' },
          { type: 'end', id: 'x' },
        ],
      },
    };
    expect(problems(flow)).toEqual([
      { path: ['flow', 'flow', 'steps', 2, 'id'], message: "duplicate step id 'x'", unsupported: false },
    ]);
  });

  it.each(['sequence', 'parallel'])("reports a %s without steps", (type) => {
    expect(problems({ ...VALID_FLOW, flow: { type, id: 'c' } })).toEqual([
      { path: ['flow', 'flow', 'steps'], message: 'needs at least one step', unsupported: false },
    ]);
  });

  it('reports a oneOf without options and an option without a step', () => {
    expect(problems({ ...VALID_FLOW, flow: { type: 'oneOf', id: 'o' } })).toEqual([
      { path: ['flow', 'flow', 'options'], message: 'needs at least one option', unsupported: false },
    ]);
    const step = { type: 'oneOf', id: 'o', options: [{ condition: 'x' }] };
    expect(problems({ ...VALID_FLOW, flow: step })).toEqual([
      { path: ['flow', 'flow', 'options', 0, 'step'], message: 'required', unsupported: false },
    ]);
  });

  it.each([5, 'list', null])("reports a forEach items that is %s", (items) => {
    expect(problems({ ...VALID_FLOW, flow: { type: 'forEach', id: 'f', items } })).toEqual([
      { path: ['flow', 'flow', 'items'], message: "a list or a '$variable'", unsupported: false },
    ]);
  });

  it('accepts a forEach with an items array or a $variable', () => {
    for (const items of [['a'], '$list']) {
      expect(problems({ ...VALID_FLOW, flow: { type: 'forEach', id: 'f', items } })).toEqual([]);
    }
  });

  it.each([
    ['toolCall', 'tool'],
    ['llmCall', 'prompt'],
    ['setVariable', 'variable'],
    ['evaluator', 'expression'],
    ['approval', 'message'],
  ])("reports a %s without '%s'", (type, field) => {
    expect(problems({ ...VALID_FLOW, flow: { type, id: 'x' } })).toEqual([
      { path: ['flow', 'flow', field], message: 'required', unsupported: false },
    ]);
  });

  it("accepts an agent step for 'self' or a known subagent, flags any other name", () => {
    expect(problems({ ...VALID_FLOW, flow: { type: 'agent', id: 'a', agent: 'self' } })).toEqual([]);
    expect(problems({ ...VALID_FLOW, flow: { type: 'agent', id: 'a', agent: 'billing' } })).toEqual([]);
    expect(problems({ ...VALID_FLOW, flow: { type: 'agent', id: 'a', agent: 'ghost' } })).toEqual([
      {
        path: ['flow', 'flow', 'agent'],
        message: "no subagent 'ghost' (use 'self' or a key of subagents)",
        unsupported: false,
      },
    ]);
    expect(problems({ ...VALID_FLOW, flow: { type: 'agent', id: 'a', agent: 'billing' } }, [])).toEqual([
      {
        path: ['flow', 'flow', 'agent'],
        message: "no subagent 'billing' (use 'self' or a key of subagents)",
        unsupported: false,
      },
    ]);
  });

  it('recurses through oneOf options and forEach steps', () => {
    const flow = {
      code: 'f',
      name: 'F',
      flow: {
        type: 'oneOf',
        id: 'o',
        options: [{ step: { type: 'forEach', id: 'f', items: '$list', step: { type: 'end' } } }],
      },
    };
    expect(problems(flow)).toEqual([
      {
        path: ['flow', 'flow', 'options', 0, 'step', 'step', 'id'],
        message: 'every flow step needs an id',
        unsupported: false,
      },
    ]);
  });

  it('matches the executor handler list exactly', () => {
    // handlersByType is private; this is the parity check that keeps this copy honest.
    const handlers = (FlowExecutor as unknown as { handlersByType: Record<string, unknown> }).handlersByType;
    expect([...EXECUTABLE_TYPES].sort()).toEqual(Object.keys(handlers).sort());
  });
});

describe('flowSpecSchema', () => {
  it('accepts an AgentFlow-shaped object and rejects extra keys', () => {
    expect(flowSpecSchema.safeParse(VALID_FLOW).success).toBe(true);
    expect(flowSpecSchema.safeParse({ ...VALID_FLOW, bogus: 1 }).success).toBe(false);
    expect(flowSpecSchema.safeParse('nope').success).toBe(false);
  });
});

describe('spec flow key', () => {
  it('validates the spec-level example', () => {
    expect(parseAgentSpecV2({ ...base, flow: VALID_FLOW }).flow).toEqual(VALID_FLOW);
  });

  it('throws LOUSHO_SPEC_UNSUPPORTED for an editor-only step, naming its absolute path', () => {
    const spec = {
      ...base,
      flow: {
        code: 'f',
        name: 'F',
        flow: {
          type: 'sequence',
          id: 's',
          steps: [{ type: 'condition', id: 'c', condition: 'x', trueFlow: { type: 'end', id: 't' }, falseFlow: { type: 'end', id: 'f' } }],
        },
      },
    };
    const error = thrown(spec);
    expect(error.code).toBe('LOUSHO_SPEC_UNSUPPORTED');
    expect(error.message).toContain('flow.flow.steps.0');
  });

  it('throws LOUSHO_SPEC_INVALID for a step without an id, naming its .id', () => {
    const spec = { ...base, flow: { code: 'f', name: 'F', flow: { type: 'sequence', id: 's', steps: [{ type: 'end' }] } } };
    const error = thrown(spec);
    expect(error.code).toBe('LOUSHO_SPEC_INVALID');
    expect(error.errors).toHaveProperty('flow.flow.steps.0.id');
  });

  it('accepts an agent step naming a subagent key and rejects an unknown name', () => {
    const flow = { code: 'f', name: 'F', flow: { type: 'agent', id: 'a', agent: 'billing' } };
    const withSubagent = { ...base, subagents: { billing: { ref: 'agents/billing.yaml' } }, flow };
    expect(parseAgentSpecV2(withSubagent).flow).toEqual(flow);
    const error = thrown({ ...base, flow });
    expect(error.code).toBe('LOUSHO_SPEC_INVALID');
    expect(error.errors).toHaveProperty('flow.flow.agent');
  });
});
