import { nanoid } from 'nanoid';
import {
  EditorStep,
  StepNode,
  SequenceNode,
  ParallelNode,
  OneOfNode,
  ForEachNode,
  EvaluatorNode,
  BestOfAllNode,
  ToolNode,
  UIComponentNode,
  ConditionNode,
  LoopNode,
} from '../types';

const convertChildren = (steps: EditorStep[]): any[] =>
  steps.map((child) => convertToFlowDefinition(child));

// ------------------------------------
// EditorStep -> FlowDefinition, one converter per step type
// ------------------------------------
type StepConverters = { [K in EditorStep['type']]: (step: Extract<EditorStep, { type: K }>) => any };

const STEP_CONVERTERS: StepConverters = {
  // STEP - Basic agent execution
  step: (step: StepNode) => ({
    id: nanoid(),
    agent: step.agent,
    input: step.input,
  }),

  // SEQUENCE - Execute steps in order
  sequence: (step: SequenceNode) => ({
    id: nanoid(),
    agent: 'sequenceAgent',
    input: convertChildren(step.steps),
  }),

  // PARALLEL - Execute steps concurrently
  parallel: (step: ParallelNode) => ({
    id: nanoid(),
    agent: 'parallelAgent',
    input: convertChildren(step.steps),
  }),

  // ONE-OF - Conditional branching
  oneOf: (step: OneOfNode) => {
    const flows = step.branches.map((b) => convertToFlowDefinition(b.flow));
    const conditions = step.branches.map((b) => b.when);
    return {
      id: nanoid(),
      agent: 'oneOfAgent',
      input: flows,
      conditions: conditions,
    };
  },

  // FOR-EACH - Iterate over items
  forEach: (step: ForEachNode) => ({
    id: nanoid(),
    agent: 'forEachAgent',
    item: step.item,
    input: convertToFlowDefinition(step.inputFlow),
  }),

  // EVALUATOR - Self-improvement loop
  evaluator: (step: EvaluatorNode) => ({
    id: nanoid(),
    agent: 'optimizeAgent',
    criteria: step.criteria,
    max_iterations: step.max_iterations,
    input: convertToFlowDefinition(step.subFlow),
  }),

  // BEST-OF-ALL - Run multiple and pick best
  bestOfAll: (step: BestOfAllNode) => ({
    id: nanoid(),
    agent: 'bestOfAllAgent',
    criteria: step.criteria,
    input: convertChildren(step.steps),
  }),

  // TOOL - Direct tool execution
  tool: (step: ToolNode) => ({
    id: nanoid(),
    agent: 'toolAgent',
    input: JSON.stringify({
      toolName: step.toolName,
      toolOptions: step.toolOptions,
    }),
  }),

  // UI-COMPONENT - UI rendering step
  uiComponent: (step: UIComponentNode) => ({
    id: nanoid(),
    agent: 'uiComponentAgent',
    input: JSON.stringify({
      componentName: step.componentName,
      componentProps: step.componentProps,
    }),
  }),

  // CONDITION - If-then-else
  condition: (step: ConditionNode) => ({
    id: nanoid(),
    agent: 'oneOfAgent',
    input: [
      convertToFlowDefinition(step.trueFlow),
      convertToFlowDefinition(step.falseFlow),
    ],
    conditions: [step.condition, `!(${step.condition})`],
  }),

  // LOOP - While loop
  loop: (step: LoopNode) => ({
    id: nanoid(),
    agent: 'forEachAgent',
    item: 'iteration',
    input: convertToFlowDefinition(step.loopFlow),
    maxIterations: step.maxIterations,
    condition: step.condition,
  }),
};

const STEP_CONVERTER_BY_TYPE: ReadonlyMap<string, (step: any) => any> = new Map(
  Object.entries(STEP_CONVERTERS)
);

/**
 * Convert EditorStep to flows-ai compatible FlowDefinition
 * This recursively transforms the internal EditorStep structure
 * to the format expected by the flows-ai execution engine
 */
export function convertToFlowDefinition(step: EditorStep): any {
  const convert = STEP_CONVERTER_BY_TYPE.get(step.type);
  if (convert) {
    return convert(step);
  }

  return {
    id: nanoid(),
    agent: 'unknownAgent',
    input: '',
  };
}

const convertFromChildren = (input: any): EditorStep[] =>
  Array.isArray(input) ? input.map((child: any) => convertFromFlowDefinition(child)) : [];

/**
 * Tool and UI-component agents carry their payload as a JSON string in
 * `input`. If it cannot be parsed, fall back to a plain step.
 */
function convertJsonPayloadAgent(
  flowDef: any,
  agent: string,
  fromPayload: (payload: any) => EditorStep
): EditorStep {
  try {
    return fromPayload(JSON.parse(flowDef.input));
  } catch {
    return {
      type: 'step',
      agent,
      input: flowDef.input,
    };
  }
}

// ------------------------------------
// FlowDefinition -> EditorStep, one converter per agent name
// ------------------------------------
const AGENT_CONVERTERS: ReadonlyMap<string, (flowDef: any) => EditorStep> = new Map<
  string,
  (flowDef: any) => EditorStep
>([
  ['sequenceAgent', (flowDef) => ({ type: 'sequence', steps: convertFromChildren(flowDef.input) })],

  ['parallelAgent', (flowDef) => ({ type: 'parallel', steps: convertFromChildren(flowDef.input) })],

  [
    'oneOfAgent',
    (flowDef) => {
      const conditions = flowDef.conditions || [];
      const flows = Array.isArray(flowDef.input) ? flowDef.input : [];
      return {
        type: 'oneOf',
        branches: flows.map((flow: any, i: number) => ({
          when: conditions[i] || '',
          flow: convertFromFlowDefinition(flow),
        })),
      };
    },
  ],

  [
    'forEachAgent',
    (flowDef) => ({
      type: 'forEach',
      item: flowDef.item || '',
      inputFlow: convertFromFlowDefinition(flowDef.input),
    }),
  ],

  [
    'optimizeAgent',
    (flowDef) => ({
      type: 'evaluator',
      criteria: flowDef.criteria || '',
      max_iterations: flowDef.max_iterations,
      subFlow: convertFromFlowDefinition(flowDef.input),
    }),
  ],

  [
    'bestOfAllAgent',
    (flowDef) => ({
      type: 'bestOfAll',
      criteria: flowDef.criteria || '',
      steps: convertFromChildren(flowDef.input),
    }),
  ],

  [
    'toolAgent',
    (flowDef) =>
      convertJsonPayloadAgent(flowDef, 'toolAgent', (parsed) => ({
        type: 'tool',
        toolName: parsed.toolName || '',
        toolOptions: parsed.toolOptions || {},
      })),
  ],

  [
    'uiComponentAgent',
    (flowDef) =>
      convertJsonPayloadAgent(flowDef, 'uiComponentAgent', (parsed) => ({
        type: 'uiComponent',
        componentName: parsed.componentName || '',
        componentProps: parsed.componentProps || {},
      })),
  ],
]);

/**
 * Convert flows-ai FlowDefinition back to EditorStep
 * Useful for round-tripping and editing
 */
export function convertFromFlowDefinition(flowDef: any): EditorStep {
  const agent = flowDef.agent;
  const convert = AGENT_CONVERTERS.get(agent);
  if (convert) {
    return convert(flowDef);
  }

  return {
    type: 'step',
    agent: agent || 'defaultAgent',
    input: typeof flowDef.input === 'string' ? flowDef.input : JSON.stringify(flowDef.input),
  };
}
