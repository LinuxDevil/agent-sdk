/**
 * Ops pipeline (LOU-J8) - end-to-end demo entry point.
 *
 * Wires, in order:
 *   1. LOU-J4's monitor webhook listener (POST /webhook)
 *   2. LOU-J5's Slack tool + interaction route (POST /slack/interactions)
 *   3. LOU-J6's fixer, delegated to from the monitor agent
 *   4. LOU-J7's guardrail-gated PR creation
 * into one process.
 *
 * Safety property this wiring enforces (per the epic's own Implementation
 * Considerations): the fixer agent never runs without first passing
 * through the REAL LOU-C approval gate. The `delegate_to_fixer` tool
 * registered on the monitor agent is marked `needsApproval: true`, so
 * AgentExecutor.execute() pauses and saves a PendingApproval (via the REAL
 * ApprovalGate/ApprovalStore) the moment the monitor agent tries to call
 * it - the fixer agent's AgentExecutor.execute() call is only ever reached
 * from inside that tool's execute(), which only runs after a human clicks
 * "Fix it" in Slack and resumeAfterApproval() (LOU-C6, called for real by
 * slackInteractions.ts) resolves the approval and runs the deferred tool
 * call. There is no code path here that runs the fixer without that
 * approval round-trip.
 *
 * Defaults to the mocks/ implementations (zero external network access);
 * pass real tool descriptors/provider to wire it to a real Slack webhook,
 * GitHub token and LLM provider instead.
 */
import * as http from 'node:http';
import { AgentType, ToolDescriptor } from '../../src/types';
import { ToolRegistry } from '../../src/tools';
import { LLMProvider } from '../../src/providers/llm';
import { startMonitorServer, MonitorServerHandle } from './monitor';
import { createFixerDelegateTool, buildFixerAgent } from './fixer';
import { handleFixerPatch } from './guardedPr';
import {
  createInMemoryApprovalStore,
  extractApprovalIdFromInteraction,
  SlackInteractionPayload,
  handleSlackInteraction,
} from './slackInteractions';
import { ApprovalStore } from '../../src/execution/ApprovalGate';
import { ExecutionResult } from '../../src/execution/AgentExecutor';
import { Guardrail } from '../../src/execution/guardrails';
import { createDemoProvider } from './demoProvider';
import { createMockGithubTool } from './mocks/mockGithubTool';
import { createMockSlackTool } from './mocks/mockSlackTool';

const DELEGATE_TOOL_NAME = 'delegate_to_fixer';
const DEFAULT_CHANNEL = '#incidents';

/**
 * Pulls the fixer's extracted `patch` back out of a resumed ExecutionResult
 * by finding the delegate tool's own result message (AgentExecutor appends
 * it as a `role: 'tool'` message whose content is
 * `JSON.stringify(toolResult.result)`, and createFixerDelegateTool's
 * result shape includes a `patch` field - see fixer.ts).
 */
function extractDelegatedPatch(result: ExecutionResult, toolName: string): string | undefined {
  for (let i = result.messages.length - 1; i >= 0; i--) {
    const message = result.messages[i];
    if (message.role === 'tool' && message.toolName === toolName) {
      try {
        const parsed = JSON.parse(message.content);
        if (typeof parsed?.patch === 'string') {
          return parsed.patch;
        }
      } catch {
        // Not JSON / no patch field - keep scanning older messages.
      }
    }
  }
  return undefined;
}

export interface OpsPipelineDeps {
  provider?: LLMProvider;
  githubCreatePrTool?: ToolDescriptor;
  slackTool?: ToolDescriptor;
  approvalStore?: ApprovalStore;
  monitorHost?: string;
  monitorPort?: number;
  slackHost?: string;
  slackPort?: number;
  channel?: string;
  /**
   * Guardrails to run before considering the GitHub PR call. Defaults to
   * handleFixerPatch()'s own defaults (real secretScanGuardrail + a
   * diff-size cap) when omitted. Exposed here so callers (e.g. LOU-J9's
   * pipeline.eval.ts) can wrap the default guardrails to observe/record
   * execution order without changing which guardrails actually run.
   */
  guardrails?: Guardrail[];
}

export interface OpsPipelineHandle {
  monitor: MonitorServerHandle;
  slack: { server: http.Server; port: number; close: () => Promise<void> };
  close: () => Promise<void>;
}

const MAX_BODY_BYTES = 1024 * 1024;

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        reject(new Error(`Request body exceeds ${MAX_BODY_BYTES} byte limit`));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function parseSlackInteractionBody(raw: string): SlackInteractionPayload {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    return JSON.parse(trimmed);
  }
  const params = new URLSearchParams(raw);
  const payloadField = params.get('payload');
  if (!payloadField) {
    throw new Error('Slack interaction body missing "payload" field');
  }
  return JSON.parse(payloadField);
}

/**
 * Starts the full ops pipeline: the monitor webhook server, and a second
 * small server exposing POST /slack/interactions (kept as a separate
 * listener from the monitor server rather than merged into one
 * http.Server, since startMonitorServer() already owns its own server
 * lifecycle from LOU-J4 - both are still started from this one process
 * entry point).
 */
export async function startOpsPipeline(deps: OpsPipelineDeps = {}): Promise<OpsPipelineHandle> {
  const provider = deps.provider ?? createDemoProvider();
  const githubCreatePrTool = deps.githubCreatePrTool ?? createMockGithubTool().tool;
  const slackTool = deps.slackTool ?? createMockSlackTool().tool;
  const approvalStore = deps.approvalStore ?? createInMemoryApprovalStore();
  const channel = deps.channel ?? DEFAULT_CHANNEL;

  const fixerAgent = buildFixerAgent();
  const delegateTool = createFixerDelegateTool({ agent: fixerAgent, provider });
  // The fixer agent must never run without first passing through the
  // approval gate (this epic's own non-negotiable safety property) -
  // enforced here by flagging the delegate tool itself as needing
  // approval, so AgentExecutor.execute() pauses BEFORE ever calling it.
  const gatedDelegateTool: ToolDescriptor = { ...delegateTool, needsApproval: true };

  const toolRegistry = new ToolRegistry();
  toolRegistry.register(DELEGATE_TOOL_NAME, gatedDelegateTool);

  const monitorAgent = {
    name: 'ops-monitor',
    agentType: AgentType.SmartAssistant,
    prompt:
      'You are an ops monitor. When an alert fires, delegate it to the fixer agent via the ' +
      `${DELEGATE_TOOL_NAME} tool.`,
    tools: { [DELEGATE_TOOL_NAME]: { tool: DELEGATE_TOOL_NAME } },
  };

  const monitor = await startMonitorServer({
    executeOptions: {
      agent: monitorAgent,
      provider,
      toolRegistry,
      approvalStore,
    },
    host: deps.monitorHost,
    port: deps.monitorPort,
    onResult: async (signal, result) => {
      if (result.finishReason === 'awaiting-approval' && result.approvalId) {
        await slackTool.tool.execute!(
          {
            channel,
            message: `New error detected (${signal.signature}): ${signal.message}. Approve the fix?`,
            approvalId: result.approvalId,
          },
          {} as any
        );
      }
    },
  });

  const slackServer = http.createServer((req, res) => {
    void (async () => {
      if (req.method === 'POST' && req.url === '/slack/interactions') {
        try {
          const raw = await readBody(req);
          const payload = parseSlackInteractionBody(raw);
          const approvalId = extractApprovalIdFromInteraction(payload);

          const result = await handleSlackInteraction(payload, {
            approvalStore,
            toolRegistry,
            provider,
          });

          if (result && approvalId) {
            const patch = extractDelegatedPatch(result, DELEGATE_TOOL_NAME);
            if (patch) {
              await handleFixerPatch(patch, {
                githubCreatePrTool,
                slackTool,
                channel,
                approvalId,
                head: `fix/auto-${approvalId}`,
                guardrails: deps.guardrails,
              });
            }
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ handled: result !== undefined }));
        } catch (error) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: (error as Error).message }));
        }
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    })();
  });

  const slackHost = deps.slackHost ?? '127.0.0.1';
  const slackPort = deps.slackPort ?? 0;
  await new Promise<void>((resolve, reject) => {
    slackServer.once('error', reject);
    slackServer.listen(slackPort, slackHost, () => resolve());
  });
  const slackAddress = slackServer.address();
  const actualSlackPort = typeof slackAddress === 'object' && slackAddress ? slackAddress.port : slackPort;

  return {
    monitor,
    slack: {
      server: slackServer,
      port: actualSlackPort,
      close: () => new Promise<void>((resolve, reject) => slackServer.close((e) => (e ? reject(e) : resolve()))),
    },
    close: async () => {
      await monitor.close();
      await new Promise<void>((resolve, reject) => slackServer.close((e) => (e ? reject(e) : resolve())));
    },
  };
}

if (require.main === module) {
  const monitorPort = Number(process.env.OPS_PIPELINE_MONITOR_PORT) || 8787;
  const slackPort = Number(process.env.OPS_PIPELINE_SLACK_PORT) || 8788;

  startOpsPipeline({ monitorPort, slackPort })
    .then((handle) => {
      console.log(`ops-pipeline monitor webhook listening on http://127.0.0.1:${handle.monitor.port}/webhook`);
      console.log(
        `ops-pipeline slack interactions listening on http://127.0.0.1:${handle.slack.port}/slack/interactions`
      );
      console.log('Running against mock Slack/GitHub APIs and a deterministic demo provider by default.');
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
