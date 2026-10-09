/**
 * coding-agent-workflows - a coding agent driven by deterministic workflows
 * whose ROUTING is a typed decision, not free text.
 *
 * This is the Lousho equivalent of TypeSafe's Jev / "System One" pattern
 * (typesafe.ai/blog/introducing-system-one-models-and-jev): Jev models
 * answer STRUCTURED probabilistic questions - classify, route, score,
 * verify - instead of generating strings. Here the same role is played by
 * a `createAgent({ output: DECISION })` call: a small model returns
 * { route, confidence, reason } against a zod schema, and the workflow
 * branches on the typed fields. Low-confidence calls don't guess - they
 * escalate to the 'careful' workflow, exactly as a calibrated System One
 * router would abstain.
 *
 *   request -> TRIAGE (typed decision: route + confidence)
 *                 | 'fix'      -> fix flow (edit + verify)
 *                 | 'refactor' -> refactor flow (plan -> edit -> verify)
 *                 | 'explain'  -> explain flow (read-only, no tools)
 *                 | low confidence -> 'careful' = refactor flow regardless
 *
 * The workflows themselves are phase pipelines (see examples/phase-pipeline):
 * implement -> proof gate. The typed decision is the new part.
 *
 * Offline (default) the triage model is scripted; with OPENROUTER_API_KEY
 * it runs live on openrouter/openai/gpt-4o-mini.
 *
 * Run with: npx tsx examples/coding-agent-workflows/index.ts
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { createAgent, defineTool, resolveProvider, type LLMProvider, type SimpleAgent } from '../../src';
import { ToolRegistry } from '../../src/tools';
import { FlowBuilder, FlowExecutor, type EditorStep, type FlowExecutionResult } from '../../src/flows';
import { mockModel } from '../../src/testing';

export const LIVE_MODEL = 'openrouter/openai/gpt-4o-mini';

// ---------------------------------------------------------------------------
// The typed decision - the Jev-style step.
// ---------------------------------------------------------------------------

/** What the triage step returns: a route, its confidence, and why. */
export const DECISION = z.object({
  /** Which workflow handles the request. */
  route: z.enum(['fix', 'refactor', 'explain']),
  /** Calibrated confidence in [0, 1]. Below `confidenceFloor` the request escalates to the careful path. */
  confidence: z.number().min(0).max(1),
  /** One line of rationale, surfaced in the run log. */
  reason: z.string(),
});
export type CodingDecision = z.infer<typeof DECISION>;

/**
 * The typed-decision call. `output: DECISION` makes the provider return a
 * validated object - `result.object`, not text to parse - so the harness
 * routes on typed fields the way Jev's probabilistic outputs drive a
 * deterministic System Two program around them.
 */
export async function triage(
  request: string,
  provider: LLMProvider,
  model: string
): Promise<CodingDecision> {
  const decider = createAgent({
    name: 'triage',
    instructions:
      'You are a request router for a coding agent. Given a request, return which workflow ' +
      'should handle it: "fix" (a small targeted change), "refactor" (a structural change), ' +
      'or "explain" (a read-only question). Report honest confidence; when unsure, say so.',
    provider,
    model,
    output: DECISION,
  });
  const result = await decider.send(request);
  if (!result.object) {
    // A non-parseable reply is the System One equivalent of "cannot
    // decide": route to the careful workflow at zero confidence.
    return { route: 'refactor', confidence: 0, reason: 'triage returned no parseable decision' };
  }
  return result.object;
}

// ---------------------------------------------------------------------------
// The workflows the decision routes into.
// ---------------------------------------------------------------------------

/** Tools the fix/refactor flows can call; `explain` deliberately gets none. */
export function codingTools(applyEdits: (file: string, content: string) => Promise<string>) {
  const applyEdit = defineTool({
    name: 'apply_edit',
    description: 'Apply new content to a file in the workspace.',
    input: z.object({ file: z.string(), content: z.string() }),
    execute: async ({ file, content }) => applyEdits(file, content),
  });
  const verify = defineTool({
    name: 'verify',
    description: "Run the project's checks; returns 'PASS: ...' or 'FAIL: ...'.",
    input: z.object({ note: z.string() }),
    execute: async () => 'PASS: checks green',
  });
  const toolRegistry = new ToolRegistry();
  toolRegistry.register(applyEdit);
  toolRegistry.register(verify);
  return toolRegistry;
}

const workflowSteps = (route: 'fix' | 'refactor'): EditorStep => ({
  type: 'sequence',
  steps: [
    // 'refactor' plans first; 'fix' goes straight to the edit.
    ...(route === 'refactor'
      ? ([
          {
            type: 'llmCall',
            prompt: 'Write a short refactor plan for: {{request}}',
            outputVariable: 'plan',
          },
        ] as EditorStep[])
      : []),
    {
      type: 'llmCall',
      prompt: 'Implement the request{{plan-check}}: {{request}}. Describe the edit to apply.',
      outputVariable: 'change',
    },
    {
      type: 'toolCall',
      tool: 'apply_edit',
      arguments: { file: 'src/index.ts', content: '{{change}}' },
      outputVariable: 'applied',
    },
    {
      type: 'toolCall',
      tool: 'verify',
      arguments: { note: 'post-edit checks' },
      outputVariable: 'check',
    },
    {
      type: 'oneOf',
      options: [
        {
          condition: "check.startsWith('PASS')",
          step: { type: 'return', value: '$check' },
        },
        { step: { type: 'throw', message: 'workflow verify failed: {{check}}' } },
      ],
    },
  ],
});

/** Builds the routed workflow: oneOf on `route` (and a low-confidence fallback). */
export function buildCodingFlow(confidenceFloor: number) {
  const careful = workflowSteps('refactor');
  const steps: EditorStep = {
    type: 'oneOf',
    options: [
      // Calibrated abstention: a confident 'explain' explains; a confident
      // 'fix' fixes; EVERYTHING low-confidence takes the careful path.
      { condition: `route === 'explain' && confidence >= ${confidenceFloor}`, step: explainStep },
      { condition: `route === 'fix' && confidence >= ${confidenceFloor}`, step: workflowSteps('fix') },
      { step: careful },
    ],
  };
  return new FlowBuilder()
    .setCode('coding-agent')
    .setName('Coding agent')
    .addInput({ name: 'request', type: 'shortText', required: true })
    .setFlow(steps)
    .build();
}

const explainStep: EditorStep = {
  type: 'llmCall',
  prompt: 'Answer this question about the codebase (read-only, no edits): {{request}}',
  outputVariable: 'deliverable',
};

// ---------------------------------------------------------------------------
// The harness: triage -> route -> run workflow.
// ---------------------------------------------------------------------------

export interface CodingAgentOptions {
  provider: LLMProvider;
  model: string;
  /** Below this confidence the careful workflow runs regardless of route. Default 0.7. */
  confidenceFloor?: number;
  toolRegistry?: ToolRegistry;
}

export interface CodingAgentResult {
  decision: CodingDecision;
  /** The route actually taken ('refactor' when low-confidence escalated). */
  effectiveRoute: CodingDecision['route'];
  flow: FlowExecutionResult;
}

export async function runCodingAgent(options: CodingAgentOptions & { request: string }): Promise<CodingAgentResult> {
  const floor = options.confidenceFloor ?? 0.7;
  const decision = await triage(options.request, options.provider, options.model);
  const confident = decision.confidence >= floor;
  const effectiveRoute = confident ? decision.route : 'refactor';

  if (effectiveRoute === 'explain') {
    // Read-only: no toolRegistry, so there is nothing to gate - the explain
    // step is an llmCall only.
    const agent = createAgent({ name: 'explainer', provider: options.provider, model: options.model });
    const answer = await agent.send(options.request);
    return {
      decision,
      effectiveRoute,
      flow: {
        status: 'completed',
        success: true,
        output: answer.text,
        variables: {},
        steps: 1,
        events: [],
        usage: { promptTokens: answer.usage.inputTokens, completionTokens: answer.usage.outputTokens, totalTokens: answer.usage.totalTokens },
      },
    };
  }

  const flow = buildCodingFlow(floor);
  const result = await FlowExecutor.execute(flow, {
    agent: { name: 'coding-agent', prompt: 'You are a careful coding agent.' },
    provider: options.provider,
    variables: {
      request: options.request,
      route: effectiveRoute,
      confidence: decision.confidence,
      'plan-check': effectiveRoute === 'refactor' ? ' (per plan)' : '',
    },
    toolRegistry: options.toolRegistry,
  });
  return { decision, effectiveRoute, flow: result };
}

// ---------------------------------------------------------------------------
// Demo + offline scripts
// ---------------------------------------------------------------------------

/** A workspace the demo edits: a virtual file store the apply_edit tool writes. */
export function memoryWorkspace() {
  const files = new Map<string, string>();
  return {
    files,
    applyEdits: async (file: string, content: string) => {
      files.set(file, content);
      return `applied ${content.length} chars to ${file}`;
    },
  };
}

async function main() {
  const live = Boolean(process.env.OPENROUTER_API_KEY);
  const ws = memoryWorkspace();
  const provider = live
    ? resolveProvider(LIVE_MODEL)
    : mockModel([
        { text: JSON.stringify({ route: 'fix', confidence: 0.91, reason: 'single-function change' }) },
        { text: 'greet(): add a name parameter with a default' },
      ]);

  const result = await runCodingAgent({
    provider,
    model: live ? LIVE_MODEL.split('/').slice(1).join('/') : 'mock',
    request: 'Add a default name parameter to greet().',
    toolRegistry: codingTools(ws.applyEdits),
  });

  console.log(live ? `Live on ${LIVE_MODEL}` : 'Offline (scripted)');
  console.log(`decision: ${result.decision.route} @ ${result.decision.confidence} - ${result.decision.reason}`);
  console.log(`effective route: ${result.effectiveRoute} | flow success: ${result.flow.success}`);
  console.log('workspace:', [...ws.files.keys()]);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
