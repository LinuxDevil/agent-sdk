import type { AgentFlow, EditorStep } from '@lousho/build-ai-agent';
import type { AgentGraphEdge, AgentGraphNode, AgentGraphSpec } from './types';

/**
 * Compiles a branching `AgentGraphSpec` (one containing at least one
 * `router` node) to the SDK's real declarative flow-execution format
 * (`src/flows/FlowExecutor.ts`), instead of the flat `AgentSpec`
 * `graphToSpec()` produces. This is the SDK's actual answer to 12-factor's
 * Factor 8 ("own your control flow") - see `FlowExecutor.ts`'s doc
 * comments - so a graph that genuinely branches compiles to it rather than
 * `AgentSpec`, which has no branching concept at all.
 *
 * ## What FlowExecutor node types this targets, and why
 *
 * `FlowExecutor.executeNode()`'s real `switch (node.type)` (read directly
 * off `src/flows/FlowExecutor.ts`, NOT off the exported `EditorStep` union
 * in `src/types/flow.ts` - the two have drifted apart in the core SDK,
 * `executeNode`'s param is typed `EditorStep | any` which collapses to
 * `any`, so the switch cases below are what's ACTUALLY executable today)
 * handles: `sequence`, `parallel`, `oneOf`, `forEach`, `evaluator`,
 * `llmCall`, `toolCall`, `setVariable`, `return`, `end`, `throw`. This
 * compiler only ever emits `sequence`, `llmCall`, `toolCall`, `oneOf`, and
 * `end` - the exact subset that expresses "run this llm/tool step, then
 * either continue or branch, then return a value" - because those are the
 * only ones a fixed-pipeline-plus-router graph needs:
 *
 *  - `llm` node -> `{ type: 'llmCall', prompt, model, outputVariable }`.
 *    `FlowExecutor.executeLLMCall()` interpolates `prompt` against
 *    `context.variables` and stores the text response under
 *    `outputVariable`.
 *  - `tool` node -> `{ type: 'toolCall', tool, arguments, outputVariable }`.
 *    Same idea, via `executeToolCall()` (which also runs the same
 *    `requiresSandbox` guard `AgentExecutor` does - see FlowExecutor.ts).
 *  - `router` node -> `{ type: 'oneOf', options: [{condition, step}, ...] }`.
 *    THIS is the node type this ticket's "router" concept maps onto -
 *    `FlowExecutor.executeOneOf()` evaluates each `option.condition` in
 *    order (a `{{variable}}`-interpolated string, `eval()`'d after
 *    interpolation - see `evaluateCondition()`) against the flow's runtime
 *    `variables`, taking the first branch whose condition is true, or the
 *    first branch with NO condition at all (the default). So a router
 *    branch's condition can express any JS boolean expression over
 *    whatever prior `llmCall`/`toolCall` step wrote into `variables` - this
 *    is exactly (and only) what `FlowExecutor` can actually branch on
 *    today; nothing here invents a condition shape it can't evaluate.
 *
 *    IMPORTANT, and worth being explicit about since it isn't obvious from
 *    `FlowExecutor.ts` alone: `interpolate()` (what turns `{{classify}}`
 *    into the variable's value before `eval()`) is a raw, unquoted text
 *    substitution - `{{classify}} === 'refund'` where `classify` holds the
 *    string `"refund"` interpolates to the syntactically invalid/wrong
 *    `refund === 'refund'` (a bare, undefined identifier), which
 *    `evaluateCondition()`'s try/catch swallows into `false`. A condition
 *    comparing a string variable therefore has to quote the placeholder
 *    itself, e.g. `'{{classify}}' === 'refund'` (interpolates to the valid
 *    `'refund' === 'refund'`). The Inspector's branch condition field
 *    documents this with a quoted example rather than silently producing
 *    conditions that always evaluate to `false`.
 *  - `output` node -> `{ type: 'end', value: '$<lastVariable>' }`.
 *    `executeEnd()`/`resolveValue()` resolve a `$name`-prefixed value by
 *    variable lookup, so the flow's final result is whatever the last
 *    `llmCall`/`toolCall` step on the path that was actually taken wrote.
 *
 * `approval` nodes are NOT supported on this path: `FlowExecutor` has no
 * approval/needsApproval node type and no `checkpointStore`/
 * `approvalStore` concept at all (see FlowExecutor.ts in full - there is no
 * pause/resume primitive here, unlike `AgentExecutor`). `graphToFlow()`
 * throws a clear error if an approval node is reachable from the router
 * rather than silently dropping the gate. `connectionRules.ts` already
 * steers the canvas away from wiring `router -> approval` for the same
 * reason.
 *
 * ## What a runtime variable is bound to
 *
 * Each `llm`/`tool` node's output variable name is derived from its own
 * `data.name`/`data.toolName` (sanitized to a valid `{{...}}` identifier),
 * so a router's condition can reference the human-readable name the user
 * gave that step in the Inspector - e.g. an `llm` node named `classify`
 * writes `{{classify}}`.
 */

/** Every node/branch shape this compiler emits, matching `FlowExecutor.executeNode()`'s REAL switch (see the file doc comment above for why this isn't just `EditorStep`). */
type FlowStepNode =
  | { type: 'llmCall'; prompt: string; model?: string; outputVariable: string }
  | { type: 'toolCall'; tool: string; arguments: Record<string, unknown>; outputVariable: string }
  | { type: 'oneOf'; options: { condition?: string; step: FlowStepNode }[] }
  | { type: 'sequence'; steps: FlowStepNode[] }
  | { type: 'end'; value?: string };

/** True when `graph` contains at least one `router` node - the signal `buildAgent.ts`/server code use to pick `FlowExecutor` over the flat `AgentSpec` path. */
export function hasRouterNode(graph: AgentGraphSpec): boolean {
  return graph.nodes.some((n) => n.type === 'router');
}

function sanitizeVarName(raw: string, fallback: string): string {
  const cleaned = (raw || '').trim().replace(/[^a-zA-Z0-9_]/g, '_').replace(/^([0-9])/, '_$1');
  return cleaned || fallback;
}

function nodeVarName(node: AgentGraphNode): string {
  if (node.type === 'llm') return sanitizeVarName(node.data.name, `llm_${node.id}`);
  if (node.type === 'tool') return sanitizeVarName(node.data.toolName, `tool_${node.id}`);
  return sanitizeVarName(node.id, node.id);
}

interface CompileCtx {
  nodesById: Map<string, AgentGraphNode>;
  outgoing: Map<string, AgentGraphEdge[]>;
}

/** Compiles the node at `nodeId` and everything reachable after it into a single `FlowStepNode`. `lastVar` is the output-variable name of the most recently compiled `llm`/`tool` step on this path, used by a terminal `output` node to know what to return. */
function compileFrom(nodeId: string, ctx: CompileCtx, lastVar: string | undefined): FlowStepNode {
  const node = ctx.nodesById.get(nodeId);
  if (!node) {
    throw new Error(`graphToFlow: edge references missing node '${nodeId}'`);
  }

  switch (node.type) {
    case 'llm': {
      const outputVariable = nodeVarName(node);
      const step: FlowStepNode = {
        type: 'llmCall',
        prompt: node.data.prompt,
        model: node.data.provider.model,
        outputVariable,
      };
      return continueAfter(node, step, ctx, outputVariable);
    }
    case 'tool': {
      const outputVariable = nodeVarName(node);
      const step: FlowStepNode = {
        type: 'toolCall',
        tool: node.data.toolName,
        arguments: {},
        outputVariable,
      };
      return continueAfter(node, step, ctx, outputVariable);
    }
    case 'router':
      return compileRouter(node, ctx, lastVar);
    case 'output':
      return { type: 'end', value: lastVar ? `$${lastVar}` : undefined };
    case 'approval':
      throw new Error(
        `graphToFlow: approval node '${node.id}' is reachable from a router - FlowExecutor has no approval/needsApproval node type, so a branching graph can't include one. Remove the approval node (or the router) to compile this graph.`
      );
    case 'trigger':
      throw new Error(`graphToFlow: unexpected trigger node '${node.id}' mid-graph - triggers must only feed the llm node`);
  }
}

/** Compiles a `router` node's outgoing edges into a `oneOf` step, one option per branch. */
function compileRouter(node: AgentGraphNode, ctx: CompileCtx, lastVar: string | undefined): FlowStepNode {
  const branches = ctx.outgoing.get(node.id) ?? [];
  if (branches.length < 2) {
    throw new Error(`graphToFlow: router node '${node.id}' must have at least 2 branches`);
  }
  // Conditioned branches first, then the (at most one) default branch
  // last - see AgentGraphEdge.condition's doc comment for why order
  // matters to FlowExecutor.executeOneOf()'s first-match semantics.
  const conditioned = branches.filter((e) => e.condition?.trim());
  const defaultBranches = branches.filter((e) => !e.condition?.trim());
  if (defaultBranches.length > 1) {
    throw new Error(`graphToFlow: router node '${node.id}' has more than one default (conditionless) branch`);
  }
  const ordered = [...conditioned, ...defaultBranches];
  return {
    type: 'oneOf',
    options: ordered.map((edge) => ({
      condition: edge.condition?.trim() || undefined,
      step: compileFrom(edge.target, ctx, lastVar),
    })),
  };
}

/** Chains `step` (a compiled llm/tool node) to whatever comes after it - a single non-branching next node, or nothing (a dangling terminal step). Throws if the node has more than one outgoing edge (only a `router` may fan out). */
function continueAfter(node: AgentGraphNode, step: FlowStepNode, ctx: CompileCtx, lastVar: string): FlowStepNode {
  const outgoing = ctx.outgoing.get(node.id) ?? [];
  if (outgoing.length === 0) return step;
  if (outgoing.length > 1) {
    throw new Error(`graphToFlow: non-router node '${node.id}' has ${outgoing.length} outgoing edges - only a router may branch`);
  }
  const next = compileFrom(outgoing[0].target, ctx, lastVar);
  return { type: 'sequence', steps: [step, next] };
}

/**
 * Compiles a branching graph to an `AgentFlow` for `FlowExecutor.execute()`.
 * Throws if `graph` has no `llm` node (mirrors `graphToSpec()`) or contains
 * a structural problem `graphToFlow` can't compile (an approval node
 * downstream of a router, a non-router node with multiple outgoing edges,
 * a router with fewer than 2 branches or more than one default branch) -
 * `validateGraph.ts` catches the router-shape issues earlier, inline in the
 * canvas, but this is the last line of defense before a bad graph would
 * otherwise silently produce a broken flow.
 */
export function graphToFlow(graph: AgentGraphSpec, code: string): AgentFlow {
  const llmNode = graph.nodes.find((n) => n.type === 'llm');
  if (!llmNode || llmNode.type !== 'llm') {
    throw new Error('graphToFlow: graph has no llm node - a flow needs a starting llmCall step');
  }

  const nodesById = new Map(graph.nodes.map((n) => [n.id, n]));
  const outgoing = new Map<string, AgentGraphEdge[]>();
  for (const edge of graph.edges) {
    const list = outgoing.get(edge.source) ?? [];
    list.push(edge);
    outgoing.set(edge.source, list);
  }

  const flowStep = compileFrom(llmNode.id, { nodesById, outgoing }, undefined);

  return {
    code,
    name: llmNode.data.name,
    // FlowStepNode is the real, executable shape (matching
    // FlowExecutor.executeNode()'s actual switch) - see this file's doc
    // comment for why it isn't literally `EditorStep`, the SDK's own
    // exported type for this field, which has drifted narrower than what
    // FlowExecutor can execute. Not modified here: src/types/flow.ts is
    // outside this epic's allowed scope (apps/agent-forge/** and
    // src/flows/** only).
    flow: flowStep as unknown as EditorStep,
  };
}
