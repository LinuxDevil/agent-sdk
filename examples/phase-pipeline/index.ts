/**
 * phase-pipeline - phase engineering: a deterministic phase pipeline where
 * the model fills each phase but the ORDER, the gate, and what counts as
 * "done" are owned by the harness, not the model. This is the pattern behind
 * agentic-workflow repos (phases-oss, leeovery/agentic-workflows):
 *
 *   discuss -> spec -> plan -> implement -> PROOF GATE -> done
 *                                          |
 *                               fail -> loop back to implement
 *                               (bounded by maxRetries)
 *
 * Each phase is an llmCall node writing a named variable; the proof gate is
 * a toolCall running a REAL check (tests, lint, a build - anything with a
 * binary verdict), and `oneOf` branches on its result. The model never
 * decides whether the work passed - the gate does.
 *
 * Offline (default) the model is scripted and the check tool is a stubbed
 * command runner. With OPENROUTER_API_KEY set the phases run live; the gate
 * still runs the real `node -e` check.
 *
 * Run with: npx tsx examples/phase-pipeline/index.ts
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { z } from 'zod';
import { defineTool, resolveProvider, type LLMProvider } from '../../src';
import {
  FlowBuilder,
  FlowExecutor,
  type AgentFlow,
  type EditorStep,
  type FlowExecutionResult,
} from '../../src/flows';
import { ToolRegistry } from '../../src/tools';
import { mockModel } from '../../src/testing';

export const LIVE_MODEL = 'openrouter/openai/gpt-4o-mini';

/** What the proof gate runs and how the verdict reaches `oneOf`. */
export interface ProofGate {
  /** Tool name the flow's `toolCall` node invokes. */
  toolName: string;
  /** Registry containing that tool; the flow calls it with the implementation text. */
  toolRegistry: ToolRegistry;
}

export interface PhasePipelineOptions {
  /** Provider every `llmCall` runs on (one model for all phases here). */
  provider: LLMProvider;
  /** Model id recorded on each llmCall's usage. */
  model: string;
  /** The task the pipeline works on. */
  task: string;
  /** The proof gate; omit for a gate-free pipeline (not recommended). */
  gate?: ProofGate;
  /** Implement retries after a failed proof. Default 2. */
  maxRetries?: number;
}

/**
 * The deterministic check a proof gate runs. Returns a 'PASS: <detail>' /
 * 'FAIL: <detail>' STRING - the flow interpolates `{{check}}` into prompts
 * and matches `check.startsWith('PASS')` in oneOf conditions (the safe
 * expression grammar's allow-listed method; `{{check.passed}}`-style paths
 * interpolate into prompts only as flat keys, so a string verdict keeps
 * both surfaces working).
 */
export const runCheck = defineTool({
  name: 'run_check',
  description: 'Runs the project check command and reports pass/fail.',
  input: z.object({ implementation: z.string() }),
  execute: async ({ implementation }) => {
    // A real gate runs tests/lint/a build; this demo gate requires the
    // implementation to define a function, checked by an actual node run.
    const ok =
      /function|=>\s*[{(]/.test(implementation) &&
      (await new Promise<boolean>((resolve) => {
        execFile(process.execPath, ['-e', 'process.exit(0)'], (err) => resolve(!err));
      }));
    return ok ? 'PASS: check ok' : 'FAIL: no function definition found';
  },
});

/**
 * Builds the discuss -> spec -> plan -> implement -> gate -> report flow.
 *
 * Retry shape: FlowExecutor has no early-exit - `sequence` runs every step
 * and `return` just resolves a value - so the bounded implement->check
 * ladder is a chain of `oneOf` nodes, each guarding an attempt on
 * `!check.startsWith('PASS')`. After the ladder, a final oneOf either runs
 * the report phase and returns `$deliverable`, or throws. (`$var`, not a
 * `{{spec}}` bundle - resolveValue reads whole variables, it doesn't
 * interpolate inside object literals.)
 */
export function buildPhaseFlow(gate?: ProofGate, maxRetries = 2): AgentFlow {
  const implementAttempt = (): EditorStep[] => [
    {
      type: 'llmCall',
      prompt:
        'You are the implementer. Plan: {{plan}}. ' +
        'Prior check result (empty on the first attempt): {{check}}. ' +
        'Write the implementation for: {{task}}',
      outputVariable: 'implementation',
    },
    {
      type: 'toolCall',
      tool: gate!.toolName,
      arguments: { implementation: '{{implementation}}' },
      outputVariable: 'check',
    },
  ];

  const implementPhase: EditorStep = gate
    ? {
        type: 'sequence',
        steps: Array.from({ length: maxRetries + 1 }, () => ({
          type: 'oneOf',
          options: [
            {
              // Attempts after a PASS are skipped; attempts after a FAIL
              // re-run implement with the check string in the prompt.
              condition: "!check.startsWith('PASS')",
              step: { type: 'sequence', steps: implementAttempt() },
            },
            { step: { type: 'sequence', steps: [] } },
          ],
        })),
      }
    : {
        type: 'llmCall',
        prompt: 'You are the implementer. Plan: {{plan}}. Write the implementation for: {{task}}',
        outputVariable: 'implementation',
      };

  const steps: EditorStep[] = [
    {
      type: 'llmCall',
      prompt: 'You are the discussant. Restate the task as concrete requirements and open questions: {{task}}',
      outputVariable: 'requirements',
    },
    {
      type: 'llmCall',
      prompt: 'You are the spec writer. Requirements: {{requirements}}. Write a tight spec (no code).',
      outputVariable: 'spec',
    },
    {
      type: 'llmCall',
      prompt: 'You are the planner. Spec: {{spec}}. Write an ordered implementation plan.',
      outputVariable: 'plan',
    },
    implementPhase,
    // After the ladder: PASS composes the deliverable and returns it;
    // anything else means every attempt's check failed.
    {
      type: 'oneOf',
      options: [
        {
          condition: gate ? "check.startsWith('PASS')" : 'true',
          step: {
            type: 'sequence',
            steps: [
              {
                type: 'llmCall',
                prompt:
                  'You are the reporter. Compose the final deliverable from ' +
                  'Spec: {{spec}} | Plan: {{plan}} | Implementation: {{implementation}}',
                outputVariable: 'deliverable',
              },
              { type: 'return', value: '$deliverable' },
            ],
          },
        },
        { step: { type: 'throw', message: 'proof gate still failing after retries: {{check}}' } },
      ],
    },
  ];

  return new FlowBuilder()
    .setCode('phase-pipeline')
    .setName('Phase pipeline')
    .addInput({ name: 'task', type: 'shortText', required: true })
    .setFlow({ type: 'sequence', steps })
    .build();
}

export async function runPhasePipeline(options: PhasePipelineOptions): Promise<FlowExecutionResult> {
  const flow = buildPhaseFlow(options.gate, options.maxRetries);
  return FlowExecutor.execute(flow, {
    agent: { name: 'phase-agent', prompt: 'You work through fixed phases.' },
    provider: options.provider,
    // `check` starts as 'not run yet' so `!check.startsWith('PASS')` lets
    // the first attempt run; each attempt's toolCall overwrites it.
    variables: { task: options.task, check: 'not run yet' },
    toolRegistry: options.gate?.toolRegistry,
  });
}

// ---------------------------------------------------------------------------
// Offline scripts + demo
// ---------------------------------------------------------------------------

/** The phase outputs, in order: requirements, spec, plan, implement attempts, report. */
export function scriptedPhases(implementations: string[], report = 'Deliverable: greet() implemented and checked.') {
  return mockModel([
    { text: 'Requirements: a greet(name) function; question: default greeting?' },
    { text: 'Spec: export greet(name) -> string, default "hello".' },
    { text: 'Plan: 1. add greet.ts, 2. export it, 3. verify with node.' },
    ...implementations.map((text) => ({ text })),
    { text: report },
  ]);
}

async function main() {
  const live = Boolean(process.env.OPENROUTER_API_KEY);
  const toolRegistry = new ToolRegistry();
  toolRegistry.register(runCheck);

  const result = await runPhasePipeline({
    provider: live
      ? resolveProvider(LIVE_MODEL)
      : scriptedPhases(['export function greet(name) { return `hello ${name}` }']),
    model: live ? LIVE_MODEL.split('/').slice(1).join('/') : 'mock',
    task: 'Add a greet(name) function with a default greeting.',
    gate: { toolName: 'run_check', toolRegistry },
  });

  console.log(live ? `Live run on ${LIVE_MODEL}` : 'Offline run with scripted model');
  console.log(`success: ${result.success}, steps: ${result.steps}`);
  console.log(result.output);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
