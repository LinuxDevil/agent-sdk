/**
 * `KindRules` for `output` nodes — the agent's `spec.output`
 * (`OutputSpecV2`: a JSON Schema object the final reply is validated into
 * `result.object` with, plus the `promptSchema`/`responseFormat` options).
 * `validate` checks the schema is an object schema and that every
 * `required` entry names a declared property. There is no `connectFrom`:
 * the `agent → output` re-own uses the default attach effect, and
 * `CONNECTION_RULES`/the instance rules refuse a second output per agent.
 * `duplicateData` returns the same schema — `duplicateNode` refuses output
 * nodes outright (a spec carries at most one `output` per agent), so the
 * hook only exists to satisfy the kind contract.
 */
import type { KindRules } from '../kindRules';
import { ownerSpecPrefix } from '../order';
import type { Graph, GraphNode, NodeOfKind, Problem } from '../types';

/** The refusal the palette and a refused drop share when the owner already has an output schema. */
const OUTPUT_TAKEN_REASON = 'This agent already has an output schema';

/** The validation message the Inspector's schema check and `validate` share. */
const OUTPUT_SCHEMA_MESSAGE = 'The output schema must be an object schema';

/** The spec path of an output node: `<owner prefix>output` — the section is one object, never `output[i]`. */
function outputSpecPath(graph: Graph, node: GraphNode): string {
  return `${ownerSpecPrefix(node.owner, graph)}output`;
}

/** The live `output` node owned by `ownerId`, if any — a spec carries at most one `output` per agent. */
function agentOutputNode(graph: Graph, ownerId: string | null): GraphNode | undefined {
  return graph.nodes.find(
    (n) => n.kind === 'output' && n.owner === ownerId && n.proposed !== 'remove'
  );
}

/** `PaletteEntry.unavailable` for the output entry: the reason, or `undefined` when the owner can take one. */
export function outputUnavailableReason(graph: Graph, owner: string | null): string | undefined {
  return agentOutputNode(graph, owner) === undefined ? undefined : OUTPUT_TAKEN_REASON;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `check` for the Inspector's schema `JsonField`: a JSON Schema the output
 * section accepts must be an object schema (`type: 'object'`), matching
 * the first `validate` row.
 */
export function outputSchemaCheck(value: unknown): string | undefined {
  return isPlainObject(value) && value.type === 'object' ? undefined : OUTPUT_SCHEMA_MESSAGE;
}

/** The `OutputSpecV2` validation rows, in the ticket's order. */
function outputProblems(node: NodeOfKind<'output'>, graph: Graph): Problem[] {
  const path = outputSpecPath(graph, node);
  const schema = node.data.item.jsonSchema;
  const problems: Problem[] = [];
  const fail = (field: string, message: string): void => {
    problems.push({ nodeId: node.id, severity: 'error', message, fieldPath: `${path}.${field}` });
  };
  if (!isPlainObject(schema) || schema.type !== 'object') {
    fail('jsonSchema', OUTPUT_SCHEMA_MESSAGE);
    return problems;
  }
  const properties = isPlainObject(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const name of required) {
    const key = String(name);
    if (!(key in properties)) {
      fail('jsonSchema.required', `'${key}' is required but not defined`);
    }
  }
  return problems;
}

/** `output` kind rules: validation plus the duplicate hook (refused upstream by `duplicateNode`). */
export const outputRules: KindRules<'output'> = {
  validate: (node, graph) => outputProblems(node, graph),
  duplicateData: (node) => ({ item: structuredClone(node.data.item) }),
};
