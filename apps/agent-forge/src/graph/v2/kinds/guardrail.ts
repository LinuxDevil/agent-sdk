/**
 * `KindRules` for `guardrail` nodes — every `spec.guardrails` entry
 * (`GuardrailSpec`). `validate` checks the picked name, the item id (the
 * `guard:<id>` node id and the trip name come from it), the per-built-in
 * required options, the `runInParallel` name+input-side rule and the
 * parallel/rewrite pairing, and that a `regex` option pattern compiles.
 * No `connectFrom`: an incoming `agent → guardrail` edge takes the default
 * re-own effect, and `CONNECTION_RULES.guardrail` is empty, so a guardrail
 * never sources an edge. `duplicateData` gives the copy the next free
 * `g<n>` item id.
 */
import type { KindRules } from '../kindRules';
import { nextItemId } from '../nodeIds';
import { arrayItemSpecPath } from '../order';
import { guardrailSidesOf, REWRITABLE_GUARDRAILS, SPEC_ID_PATTERN } from '../specTypes';
import type { Graph, GuardrailNodeData, NodeOfKind, Problem } from '../types';

/**
 * The `item.id` rule the Inspector and the validator share — the SDK's
 * `specIdSchema` pattern (`SPEC_ID_PATTERN`), re-exported through
 * `specTypes`, so the canvas flags exactly the ids a spec cannot carry.
 */
export const GUARDRAIL_ID_PATTERN = SPEC_ID_PATTERN;

/**
 * Every guardrail's `item.id` — the `taken` set for `nextItemId('g', …)`
 * when the palette entry or a duplicate names a new guardrail (guardrail
 * ids are unique across the whole graph, per the `duplicateItemIds` core
 * check).
 */
export function allGuardrailIds(graph: Graph): string[] {
  return graph.nodes
    .filter((n) => n.kind === 'guardrail')
    .map((n) => (n.data as GuardrailNodeData).item.id);
}

/**
 * The built-ins that may check the input while the first model call is in
 * flight — only `promptInjectionGuardrail` and `moderationGuardrail` take
 * `runInParallel` in the SDK starter set.
 */
export const PARALLEL_GUARDRAILS = ['prompt-injection', 'moderation'] as const;

/** The user-facing refusal the Inspector switch and the validator share. */
const PARALLEL_MESSAGE = 'Only prompt-injection and moderation can run in parallel, on input';

/** Options each built-in must carry (an empty string or empty array counts as missing). */
const REQUIRED_OPTIONS: Record<string, readonly string[]> = {
  'llm-judge': ['model'],
  moderation: ['model'],
  regex: ['pattern'],
  'deny-topics': ['topics'],
};

/** `pattern` compiles as a regular expression. */
function compiles(pattern: string): boolean {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

/** `undefined`, `null`, `''` or `[]` — the option counts as absent. */
function missing(value: unknown): boolean {
  return (
    value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)
  );
}

/** The name and id rows. */
function identityProblems(node: NodeOfKind<'guardrail'>, path: string): Problem[] {
  const { item } = node.data;
  const problems: Problem[] = [];
  if (!item.name) {
    problems.push({ nodeId: node.id, severity: 'error', message: 'Pick a guardrail', fieldPath: `${path}.name` });
  }
  if (!GUARDRAIL_ID_PATTERN.test(item.id)) {
    problems.push({
      nodeId: node.id,
      severity: 'error',
      message: 'The id can use letters, digits, dot, dash or underscore',
      fieldPath: `${path}.id`,
    });
  }
  return problems;
}

/** The required-option rows for the picked built-in. */
function optionProblems(node: NodeOfKind<'guardrail'>, path: string): Problem[] {
  const { item } = node.data;
  const problems: Problem[] = [];
  for (const option of REQUIRED_OPTIONS[item.name] ?? []) {
    if (missing(item.options?.[option])) {
      problems.push({
        nodeId: node.id,
        severity: 'error',
        message: `This guardrail needs the '${option}' option`,
        fieldPath: `${path}.options.${option}`,
      });
    }
  }
  const pattern = item.name === 'regex' ? item.options?.['pattern'] : undefined;
  if (typeof pattern === 'string' && pattern !== '' && !compiles(pattern)) {
    problems.push({
      nodeId: node.id,
      severity: 'error',
      message: 'The pattern is not a valid regular expression',
      fieldPath: `${path}.options.pattern`,
    });
  }
  return problems;
}

/**
 * The `onTripped` rows the SDK enforces (`refineGuardrail` in
 * `src/spec/v2/guardrails.ts`): 'warn' has no SDK mechanism, 'rewrite' is
 * limited to the rewritable built-ins, and `onTripped` must not disagree
 * with `options.action`.
 */
function trippedProblems(node: NodeOfKind<'guardrail'>, path: string): Problem[] {
  const { item } = node.data;
  const problems: Problem[] = [];
  if (item.onTripped === 'warn') {
    problems.push({
      nodeId: node.id,
      severity: 'error',
      message: "'warn' is not supported; use 'block' or 'rewrite'",
      fieldPath: `${path}.onTripped`,
    });
  }
  if (item.onTripped === 'rewrite' && !(REWRITABLE_GUARDRAILS as readonly string[]).includes(item.name)) {
    problems.push({
      nodeId: node.id,
      severity: 'error',
      message: `'${item.name}' cannot rewrite; use 'block'`,
      fieldPath: `${path}.onTripped`,
    });
  }
  const action = item.options?.['action'];
  if (item.onTripped !== undefined && action !== undefined && action !== item.onTripped) {
    problems.push({
      nodeId: node.id,
      severity: 'error',
      message: 'set either onTripped or options.action, not both',
      fieldPath: `${path}.options.action`,
    });
  }
  return problems;
}

/** The action a trip compiles to: `onTripped` wins over `options.action` (the SDK's `effectiveAction`). */
function effectiveAction(item: GuardrailNodeData['item']): unknown {
  return item.onTripped === 'block' || item.onTripped === 'rewrite' ? item.onTripped : item.options?.['action'];
}

/** The `runInParallel` rows: input-side built-ins only, and a parallel check cannot rewrite. */
function parallelProblems(node: NodeOfKind<'guardrail'>, path: string): Problem[] {
  const { item } = node.data;
  if (item.runInParallel !== true) return [];
  const problems: Problem[] = [];
  const parallelName = (PARALLEL_GUARDRAILS as readonly string[]).includes(item.name);
  if (!parallelName || !guardrailSidesOf(item).includes('input')) {
    problems.push({
      nodeId: node.id,
      severity: 'error',
      message: PARALLEL_MESSAGE,
      fieldPath: `${path}.runInParallel`,
    });
  }
  if (effectiveAction(item) === 'rewrite') {
    problems.push({
      nodeId: node.id,
      severity: 'error',
      message: 'A parallel check cannot rewrite',
      fieldPath: item.onTripped === 'rewrite' ? `${path}.onTripped` : `${path}.options.action`,
    });
  }
  return problems;
}

/**
 * `guardrail` kind rules: validation plus the duplicate's fresh `g<n>` id.
 * The `guards` edge is derived from ownership (`deriveEdges`), so the only
 * connect behaviour needed is the default re-own attach.
 */
export const guardrailRules: KindRules<'guardrail'> = {
  validate: (node, graph) => {
    const path = arrayItemSpecPath(graph, node, 'guardrails');
    return [
      ...identityProblems(node, path),
      ...optionProblems(node, path),
      ...trippedProblems(node, path),
      ...parallelProblems(node, path),
    ];
  },
  duplicateData: (node, graph) => ({
    item: {
      ...structuredClone(node.data.item),
      id: nextItemId('g', allGuardrailIds(graph)),
    },
  }),
};
