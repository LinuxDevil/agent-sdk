import { jsonSchemaToZod } from '../../tools/mcp/schema';
import { issueMessage } from '../../utils/zodCompat';

/** One problem with a page's inputs. */
export interface InputProblem {
  /** Where, as `inputs` or `inputs.<path>`. */
  path: string;
  /** What is wrong, for people. */
  message: string;
}

export function schemaProblems(schema: Record<string, unknown>, value: unknown, root: string): InputProblem[] {
  const result = jsonSchemaToZod(schema).safeParse(value);
  if (result.success) return [];
  return result.error.issues.map((issue) => ({ path: [root, ...issue.path.map(String)].join('.'), message: issueMessage(issue) }));
}

/** Checks page inputs against the effective `inputs.schema` with the JSON-Schema converter the runtime uses; empty when they are valid. Browser-safe. */
export function checkPageInputs(schema: Record<string, unknown>, inputs: unknown): InputProblem[] {
  return schemaProblems(schema, inputs, 'inputs');
}
