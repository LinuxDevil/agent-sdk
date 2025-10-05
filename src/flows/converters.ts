import { nanoid } from 'nanoid';
import { EditorStep } from '../types';

/**
 * Convert EditorStep to flows-ai compatible FlowDefinition
 * This recursively transforms the internal EditorStep structure
 * to the format expected by the flows-ai execution engine
 */
export function convertToFlowDefinition(step: EditorStep): any {
  switch (step.type) {
    // ------------------------------------
    // STEP - Basic agent execution
    // ------------------------------------
    case 'step':
      return {
        id: nanoid(),
        agent: step.agent,
        input: step.input,
      };

    // ------------------------------------
    // SEQUENCE - Execute steps in order
    // ------------------------------------
    case 'sequence':
      return {
        id: nanoid(),
        agent: 'sequenceAgent',
        input: step.steps.map((child) => convertToFlowDefinition(child)),
      };

    // ------------------------------------
    // PARALLEL - Execute steps concurrently
    // ------------------------------------
    case 'parallel':
      return {
        id: nanoid(),
        agent: 'parallelAgent',
        input: step.steps.map((child) => convertToFlowDefinition(child)),
      };

    // ------------------------------------
    // ONE-OF - Conditional branching
    // ------------------------------------
    case 'oneOf':
      const flows = step.branches.map((b) => convertToFlowDefinition(b.flow));
      const conditions = step.branches.map((b) => b.when);
      return {
        id: nanoid(),
        agent: 'oneOfAgent',
        input: flows,
        conditions: conditions,
      };

    // ------------------------------------
    // FOR-EACH - Iterate over items
    // ------------------------------------
    case 'forEach':
      return {
        id: nanoid(),
        agent: 'forEachAgent',
        item: step.item,
        input: convertToFlowDefinition(step.inputFlow),
      };

    // ------------------------------------
    // EVALUATOR - Self-improvement loop
    // ------------------------------------
    case 'evaluator':
      return {
        id: nanoid(),
        agent: 'optimizeAgent',
        criteria: step.criteria,
        max_iterations: step.max_iterations,
        input: convertToFlowDefinition(step.subFlow),
      };

    // ------------------------------------
    // BEST-OF-ALL - Run multiple and pick best
    // ------------------------------------
    case 'bestOfAll':
      return {
        id: nanoid(),
        agent: 'bestOfAllAgent',
        criteria: step.criteria,
        input: step.steps.map((child) => convertToFlowDefinition(child)),
      };

    // ------------------------------------
    // TOOL - Direct tool execution
    // ------------------------------------
    case 'tool':
      return {
        id: nanoid(),
        agent: 'toolAgent',
        input: JSON.stringify({
          toolName: step.toolName,
          toolOptions: step.toolOptions,
        }),
      };

    // ------------------------------------
    // UI-COMPONENT - UI rendering step
    // ------------------------------------
    case 'uiComponent':
      return {
        id: nanoid(),
        agent: 'uiComponentAgent',
        input: JSON.stringify({
          componentName: step.componentName,
          componentProps: step.componentProps,
        }),
      };

    // ------------------------------------
    // CONDITION - If-then-else
    // ------------------------------------
    case 'condition':
      return {
        id: nanoid(),
        agent: 'oneOfAgent',
        input: [
          convertToFlowDefinition(step.trueFlow),
          convertToFlowDefinition(step.falseFlow),
        ],
        conditions: [step.condition, `!(${step.condition})`],
      };

    // ------------------------------------
    // LOOP - While loop
    // ------------------------------------
    case 'loop':
      return {
        id: nanoid(),
        agent: 'forEachAgent',
        item: 'iteration',
        input: convertToFlowDefinition(step.loopFlow),
        maxIterations: step.maxIterations,
        condition: step.condition,
      };

    default:
      return {
        id: nanoid(),
        agent: 'unknownAgent',
        input: '',
      };
  }
}

/**
 * Convert flows-ai FlowDefinition back to EditorStep
 * Useful for round-tripping and editing
 */
export function convertFromFlowDefinition(flowDef: any): EditorStep {
  const agent = flowDef.agent;

  switch (agent) {
    case 'sequenceAgent':
      return {
        type: 'sequence',
        steps: Array.isArray(flowDef.input)
          ? flowDef.input.map((child: any) => convertFromFlowDefinition(child))
          : [],
      };

    case 'parallelAgent':
      return {
        type: 'parallel',
        steps: Array.isArray(flowDef.input)
          ? flowDef.input.map((child: any) => convertFromFlowDefinition(child))
          : [],
      };

    case 'oneOfAgent':
      const conditions = flowDef.conditions || [];
      const flows = Array.isArray(flowDef.input) ? flowDef.input : [];
      return {
        type: 'oneOf',
        branches: flows.map((flow: any, i: number) => ({
          when: conditions[i] || '',
          flow: convertFromFlowDefinition(flow),
        })),
      };

    case 'forEachAgent':
      return {
        type: 'forEach',
        item: flowDef.item || '',
        inputFlow: convertFromFlowDefinition(flowDef.input),
      };

    case 'optimizeAgent':
      return {
        type: 'evaluator',
        criteria: flowDef.criteria || '',
        max_iterations: flowDef.max_iterations,
        subFlow: convertFromFlowDefinition(flowDef.input),
      };

    case 'bestOfAllAgent':
      return {
        type: 'bestOfAll',
        criteria: flowDef.criteria || '',
        steps: Array.isArray(flowDef.input)
          ? flowDef.input.map((child: any) => convertFromFlowDefinition(child))
          : [],
      };

    case 'toolAgent':
      try {
        const parsed = JSON.parse(flowDef.input);
        return {
          type: 'tool',
          toolName: parsed.toolName || '',
          toolOptions: parsed.toolOptions || {},
        };
      } catch {
        return {
          type: 'step',
          agent: 'toolAgent',
          input: flowDef.input,
        };
      }

    case 'uiComponentAgent':
      try {
        const parsed = JSON.parse(flowDef.input);
        return {
          type: 'uiComponent',
          componentName: parsed.componentName || '',
          componentProps: parsed.componentProps || {},
        };
      } catch {
        return {
          type: 'step',
          agent: 'uiComponentAgent',
          input: flowDef.input,
        };
      }

    default:
      return {
        type: 'step',
        agent: agent || 'defaultAgent',
        input: typeof flowDef.input === 'string' ? flowDef.input : JSON.stringify(flowDef.input),
      };
  }
}
