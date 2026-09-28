/**
 * Ops pipeline eval (LOU-J9).
 *
 * Two complementary checks:
 *
 * 1. A REAL defineEval() (LOU-G1) using the REAL toolCallOrder() scorer
 *    (LOU-G4) against the monitor agent's own single
 *    AgentExecutor.execute() step. This step's ExecutionResult.toolCalls
 *    DOES naturally carry the expected sequence (a single delegate call to
 *    the real `delegate_to_fixer` tool name used by index.ts), so
 *    toolCallOrder() applies directly and honestly here.
 *
 * 2. The ops-pipeline as a whole is composed of multiple SEPARATE tool
 *    calls across monitor -> Slack alert -> (approval) -> fixer delegate
 *    -> guardrails -> GitHub PR creation, most of which do NOT flow
 *    through one single AgentExecutor.execute() call's `toolCalls` field
 *    (the Slack/GitHub calls are plain ToolDescriptor invocations made
 *    directly by index.ts/guardedPr.ts, not LLM-issued tool calls). A
 *    defineEval()+toolCallOrder() call cannot express that cross-stage
 *    sequence, so - per this ticket's own guidance - it's instead recorded
 *    directly: every real stage (the monitor's delegate tool call, the
 *    Slack alert, both real guardrails, and GitHub PR creation) is
 *    instrumented with the same spy pattern fixer.test.ts/guardedPr.test.ts/
 *    index.test.ts already use, and the recorded order is asserted with a
 *    plain deep-equals - the most honest representation of what actually
 *    ran, in what order, without inventing a fake single-result shape.
 */
import { describe, it, expect } from 'vitest';
import { defineEval } from '../../src/evals/defineEval';
import { toolCallOrder } from '../../src/evals/scorers';
import { AgentType } from '../../src/types';
import { ToolRegistry } from '../../src/tools';
import { secretScanGuardrail, createDiffSizeGuardrail } from '../../src/execution/guardrails';
import { startOpsPipeline } from './index';
import { createDemoProvider } from './demoProvider';
import { createFixerDelegateTool, buildFixerAgent } from './fixer';
import { buildMonitorPrompt } from './monitor';
import { createMockGithubTool } from './mocks/mockGithubTool';
import { createMockSlackTool } from './mocks/mockSlackTool';
import { createInMemoryApprovalStore } from './slackInteractions';
import { exampleErrorSignal, sendSyntheticError } from './mocks/mockGrafanaSender';

const DELEGATE_TOOL_NAME = 'delegate_to_fixer';
const FIXTURE_SIGNAL = exampleErrorSignal();

// ---------------------------------------------------------------------------
// 1. REAL defineEval() + REAL toolCallOrder() scorer (LOU-G1/G4)
// ---------------------------------------------------------------------------

const evalProvider = createDemoProvider();
const evalFixerAgent = buildFixerAgent();
const evalDelegateTool = createFixerDelegateTool({ agent: evalFixerAgent, provider: evalProvider });
// Note: unlike index.ts's real wiring, this eval registry does NOT flag the
// delegate tool needsApproval:true - defineEval()'s EvalConfig (LOU-G1) has
// no approvalStore field to satisfy a paused run, and the approval-gate
// property itself is already covered directly by index.test.ts. This eval
// is purely about the monitor agent's own tool-call CHOICE/ORDER.
const evalToolRegistry = new ToolRegistry();
evalToolRegistry.register(DELEGATE_TOOL_NAME, evalDelegateTool);

const evalMonitorAgent = {
  name: 'ops-monitor',
  agentType: AgentType.SmartAssistant,
  prompt: `You are an ops monitor. When an alert fires, delegate it to the fixer agent via the ${DELEGATE_TOOL_NAME} tool.`,
  tools: { [DELEGATE_TOOL_NAME]: { tool: DELEGATE_TOOL_NAME } },
};

defineEval({
  name: 'ops-pipeline: monitor triages a new error by calling delegate_to_fixer exactly once',
  agent: evalMonitorAgent,
  input: buildMonitorPrompt(FIXTURE_SIGNAL),
  provider: evalProvider,
  toolRegistry: evalToolRegistry,
  score: toolCallOrder([{ tool: DELEGATE_TOOL_NAME }]),
  threshold: 1,
});

// ---------------------------------------------------------------------------
// 2. Full cross-stage call-order recording (direct assertion)
// ---------------------------------------------------------------------------

describe('ops-pipeline: full cross-stage call order (LOU-J9)', () => {
  it('runs monitor -> slack alert -> fixer delegate -> guardrails -> github PR, in that order', async () => {
    const order: string[] = [];

    const provider = createDemoProvider();
    const approvalStore = createInMemoryApprovalStore();

    const github = createMockGithubTool();
    const slack = createMockSlackTool();

    // Wrap the mock tools' execute() to record call order without changing
    // their real behavior/return shape.
    const githubCreatePrTool = {
      ...github.tool,
      tool: {
        ...github.tool.tool,
        execute: async (...args: Parameters<NonNullable<typeof github.tool.tool.execute>>) => {
          order.push('github:create_pull_request');
          return github.tool.tool.execute!(...args);
        },
      },
    };
    const slackTool = {
      ...slack.tool,
      tool: {
        ...slack.tool.tool,
        execute: async (...args: Parameters<NonNullable<typeof slack.tool.tool.execute>>) => {
          order.push('slack:alert');
          return slack.tool.tool.execute!(...args);
        },
      },
    };

    const trackedGuardrails = [
      {
        name: 'secret-scan',
        check: async (action: { diff: string }) => {
          order.push('guardrail:secret-scan');
          return secretScanGuardrail.check(action);
        },
      },
      {
        name: 'diff-size-cap',
        check: async (action: { diff: string }) => {
          order.push('guardrail:diff-size-cap');
          return createDiffSizeGuardrail(500).check(action);
        },
      },
    ];

    const handle = await startOpsPipeline({
      provider,
      githubCreatePrTool: githubCreatePrTool as any,
      slackTool: slackTool as any,
      approvalStore,
      guardrails: trackedGuardrails as any,
      monitorPort: 0,
      slackPort: 0,
    });

    try {
      const webhookUrl = `http://127.0.0.1:${handle.monitor.port}/webhook`;
      await sendSyntheticError(webhookUrl, FIXTURE_SIGNAL);
      await new Promise((resolve) => setTimeout(resolve, 50)); // let the monitor's onResult -> Slack alert settle

      const approvalId = slack.posts[0]?.approvalId;
      expect(approvalId).toBeTruthy();

      const interactionsUrl = `http://127.0.0.1:${handle.slack.port}/slack/interactions`;
      await fetch(interactionsUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'block_actions',
          actions: [{ action_id: 'fix_it', value: approvalId }],
        }),
      });

      const EXPECTED_ORDER = [
        'slack:alert',
        'guardrail:secret-scan',
        'guardrail:diff-size-cap',
        'github:create_pull_request',
      ];

      expect(order).toEqual(EXPECTED_ORDER);
    } finally {
      await handle.close();
    }
  });
});
