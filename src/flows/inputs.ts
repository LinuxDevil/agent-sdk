import { z } from 'zod';
import { FlowInputVariable, FlowInputType } from '../types';

/**
 * Extract variable names from a string in the format @variableName
 * Returns array of variable names without the @ prefix
 */
export function extractVariableNames(str: string): string[] {
  const regex = /@([a-zA-Z0-9_]+)/g;
  const result: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = regex.exec(str)) !== null) {
    result.push(match[1]);
  }
  return result;
}

/**
 * Replace all occurrences of @variableName with actual values
 */
export function replaceVariablesInString(
  str: string,
  variables: Record<string, string>
): string {
  let result = str;
  for (const [name, value] of Object.entries(variables)) {
    const pattern = new RegExp(`@${name}`, 'g');
    result = result.replace(pattern, value);
  }
  return result;
}

const LIST_CHILD_AGENTS: ReadonlySet<unknown> = new Set([
  'sequenceAgent',
  'parallelAgent',
  'bestOfAllAgent',
  'oneOfAgent',
]);

const SINGLE_CHILD_AGENTS: ReadonlySet<unknown> = new Set(['forEachAgent', 'optimizeAgent']);

/**
 * A node of an agent-style flow definition (`{ agent: 'sequenceAgent', input: [...] }`),
 * the fields {@link injectVariables} and {@link applyInputTransformation} read and write.
 */
export interface FlowDefinitionNode {
  agent?: string;
  name?: string;
  /** A string, the child nodes (list-style agents) or the child node (wrapper-style agents). */
  input?: unknown;
  conditions?: unknown;
  criteria?: unknown;
}

/**
 * Nested flow nodes of a flow definition: the input array of list-style
 * agents, or the single input object of wrapper-style agents.
 */
function getChildNodes(flowDef: FlowDefinitionNode): FlowDefinitionNode[] {
  if (LIST_CHILD_AGENTS.has(flowDef.agent)) {
    return listChildNodes(flowDef.input);
  }
  if (SINGLE_CHILD_AGENTS.has(flowDef.agent)) {
    return singleChildNode(flowDef.input);
  }
  return [];
}

function listChildNodes(input: unknown): FlowDefinitionNode[] {
  return Array.isArray(input) ? input : [];
}

function singleChildNode(input: unknown): FlowDefinitionNode[] {
  return input && typeof input === 'object' ? [input] : [];
}

/**
 * Inject variable values into a flow definition recursively
 */
export function injectVariables<T extends FlowDefinitionNode>(
  flowDef: T,
  variables: Record<string, string>
): T {
  injectNodeVariables(flowDef, variables);
  return flowDef;
}

function injectNodeVariables(flowDef: FlowDefinitionNode, variables: Record<string, string>): void {
  // Replace variables in string input
  if (typeof flowDef.input === 'string') {
    flowDef.input = replaceVariablesInString(flowDef.input, variables);
  }

  // Replace variables in conditions (oneOf)
  if (Array.isArray(flowDef.conditions)) {
    flowDef.conditions = flowDef.conditions.map((cond: string) =>
      replaceVariablesInString(cond, variables)
    );
  }

  // Replace variables in criteria (evaluator, bestOfAll)
  if (typeof flowDef.criteria === 'string') {
    flowDef.criteria = replaceVariablesInString(flowDef.criteria, variables);
  }

  // Recursively process nested flows
  getChildNodes(flowDef).forEach((child) => injectNodeVariables(child, variables));
}

/**
 * Apply transformation function to all input fields in flow definition
 */
export async function applyInputTransformation<T extends FlowDefinitionNode>(
  flowDef: T,
  transformFn: (node: T) => unknown
): Promise<void> {
  const node: FlowDefinitionNode = flowDef;
  // Transform current node's input
  node.input = await transformFn(flowDef);

  // Set name if not present
  if (!node.name) {
    node.name = node.agent;
  }

  // Recursively transform nested nodes (a flow definition's children are nodes of the same type)
  await Promise.all(
    getChildNodes(node).map((child) => applyInputTransformation(child as T, transformFn))
  );
}

/** Base Zod schema for a flow input type (unknown types fall back to string). */
function baseSchemaForInputType(type: FlowInputType): z.ZodTypeAny {
  switch (type) {
    case 'number':
      return z.number();
    case 'json':
      return z.any();
    default:
      return z.string();
  }
}

function buildFieldSchema(inputVar: FlowInputVariable): z.ZodTypeAny {
  const fieldSchema = baseSchemaForInputType(inputVar.type).describe(
    inputVar.description || inputVar.name
  );

  // Make optional if not required
  return inputVar.required ? fieldSchema : fieldSchema.optional();
}

/**
 * Create a dynamic Zod schema from flow input variables
 */
export function createDynamicZodSchemaForInputs(options: {
  availableInputs: FlowInputVariable[];
}): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const { availableInputs } = options;

  if (!availableInputs || availableInputs.length === 0) {
    return z.object({});
  }

  const shape: Record<string, z.ZodTypeAny> = {};

  for (const inputVar of availableInputs) {
    shape[inputVar.name] = buildFieldSchema(inputVar);
  }

  return z.object(shape);
}

/** The JS typeof each input type must have; 'json' accepts any type. */
const EXPECTED_JS_TYPE: Partial<Record<FlowInputType, 'number' | 'string'>> = {
  number: 'number',
  shortText: 'string',
  longText: 'string',
  url: 'string',
  fileBase64: 'string',
};

function checkRequiredInput(variable: FlowInputVariable, value: unknown): string | null {
  if (variable.required && (value === undefined || value === null)) {
    return `Required input variable '${variable.name}' is missing`;
  }
  return null;
}

function checkInputType(variable: FlowInputVariable, value: unknown): string | null {
  const expected = EXPECTED_JS_TYPE[variable.type];
  if (value !== undefined && expected && typeof value !== expected) {
    return `Input variable '${variable.name}' must be a ${expected}`;
  }
  return null;
}

/**
 * Validate flow input against schema
 */
export function validateFlowInput(
  input: Record<string, unknown>,
  variables: FlowInputVariable[]
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  for (const variable of variables) {
    const value = input[variable.name];
    const requiredError = checkRequiredInput(variable, value);
    if (requiredError) errors.push(requiredError);

    const typeError = checkInputType(variable, value);
    if (typeError) errors.push(typeError);
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Input type labels for UI display
 */
export const INPUT_TYPE_LABELS: Record<FlowInputType, string> = {
  shortText: 'Short text',
  url: 'URL',
  longText: 'Long text',
  number: 'Number',
  json: 'JSON Object',
  fileBase64: 'File (Base64)',
};
