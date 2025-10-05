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

/**
 * Inject variable values into a flow definition recursively
 */
export function injectVariables(
  flowDef: any,
  variables: Record<string, string>
): any {
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
  const agent = flowDef.agent;
  switch (agent) {
    case 'sequenceAgent':
    case 'parallelAgent':
    case 'bestOfAllAgent':
    case 'oneOfAgent':
      if (Array.isArray(flowDef.input)) {
        flowDef.input.forEach((child: any) => injectVariables(child, variables));
      }
      break;

    case 'forEachAgent':
    case 'optimizeAgent':
      if (flowDef.input && typeof flowDef.input === 'object') {
        injectVariables(flowDef.input, variables);
      }
      break;
  }

  return flowDef;
}

/**
 * Apply transformation function to all input fields in flow definition
 */
export async function applyInputTransformation(
  flowDef: any,
  transformFn: (node: any) => Promise<any> | any
): Promise<void> {
  // Transform current node's input
  flowDef.input = await transformFn(flowDef);
  
  // Set name if not present
  if (!flowDef.name) {
    flowDef.name = flowDef.agent;
  }

  // Recursively transform nested nodes
  const agent = flowDef.agent;
  switch (agent) {
    case 'sequenceAgent':
    case 'parallelAgent':
    case 'bestOfAllAgent':
    case 'oneOfAgent':
      if (Array.isArray(flowDef.input)) {
        await Promise.all(
          flowDef.input.map((child: any) =>
            applyInputTransformation(child, transformFn)
          )
        );
      }
      break;

    case 'forEachAgent':
    case 'optimizeAgent':
      if (flowDef.input && typeof flowDef.input === 'object') {
        await applyInputTransformation(flowDef.input, transformFn);
      }
      break;
  }
}

/**
 * Create a dynamic Zod schema from flow input variables
 */
export function createDynamicZodSchemaForInputs(options: {
  availableInputs: FlowInputVariable[];
}): z.ZodObject<any> {
  const { availableInputs } = options;

  if (!availableInputs || availableInputs.length === 0) {
    return z.object({});
  }

  const shape: Record<string, z.ZodTypeAny> = {};

  for (const inputVar of availableInputs) {
    let fieldSchema: z.ZodTypeAny;

    switch (inputVar.type) {
      case 'shortText':
      case 'longText':
      case 'url':
        fieldSchema = z.string().describe(inputVar.description || inputVar.name);
        break;

      case 'number':
        fieldSchema = z.number().describe(inputVar.description || inputVar.name);
        break;

      case 'json':
        fieldSchema = z.any().describe(inputVar.description || inputVar.name);
        break;

      case 'fileBase64':
        fieldSchema = z.string().describe(inputVar.description || inputVar.name);
        break;

      default:
        fieldSchema = z.string().describe(inputVar.description || inputVar.name);
    }

    // Make optional if not required
    if (!inputVar.required) {
      fieldSchema = fieldSchema.optional();
    }

    shape[inputVar.name] = fieldSchema;
  }

  return z.object(shape);
}

/**
 * Validate flow input against schema
 */
export function validateFlowInput(
  input: any,
  variables: FlowInputVariable[]
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  for (const variable of variables) {
    if (variable.required && (input[variable.name] === undefined || input[variable.name] === null)) {
      errors.push(`Required input variable '${variable.name}' is missing`);
    }

    if (input[variable.name] !== undefined) {
      const value = input[variable.name];

      // Type validation
      switch (variable.type) {
        case 'number':
          if (typeof value !== 'number') {
            errors.push(`Input variable '${variable.name}' must be a number`);
          }
          break;

        case 'shortText':
        case 'longText':
        case 'url':
        case 'fileBase64':
          if (typeof value !== 'string') {
            errors.push(`Input variable '${variable.name}' must be a string`);
          }
          break;

        case 'json':
          // Any type is acceptable
          break;
      }
    }
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
