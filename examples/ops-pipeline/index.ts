/**
 * Ops pipeline (LOU-J8) - end-to-end demo entry point.
 *
 * Wires, in order:
 *   1. LOU-J4's monitor webhook listener (POST /webhook)
 *   2. LOU-J5's Slack tool + interaction route (POST /slack/interactions)
 *   3. LOU-J6's fixer, delegated to from the monitor agent
 *   4. LOU-J7's patch-check-gated PR creation
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
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ToolDescriptor } from '../../src/types';
import { ToolRegistry } from '../../src/tools';
import { verifySlackSignature } from '../../src/triggers';
import { LLMProvider } from '../../src/providers/llm';
import { startMonitorServer, MonitorServerHandle, StartMonitorServerOptions } from './monitor';
import { createFixerTool, buildFixerAgent } from './fixer';
import { handleFixerPatch } from './guardedPr';
import {
  createInMemoryApprovalStore,
  extractApprovalIdFromInteraction,
  handleSlackInteraction,
  parseSlackInteractionBody,
  readBody,
} from './slackInteractions';
import { closeServer, listenOn, sendJson, sendNotFound } from './httpHelpers';
import { ApprovalStore } from '../../src/execution/ApprovalGate';
import { ExecutionResult } from '../../src/execution/AgentExecutor';
import { PatchCheck } from '../../src/execution/patchChecks';
import { createDemoProvider } from './demoProvider';
import { createMockGithubTool } from './mocks/mockGithubTool';
import { createMockSlackTool } from './mocks/mockSlackTool';
import { textOf } from '../../src/providers/content';

const DELEGATE_TOOL_NAME = 'delegate_to_fixer';
const DEFAULT_CHANNEL = '#incidents';

/**
 * Pulls the fixer's extracted `patch` back out of a resumed ExecutionResult
 * by finding the delegate tool's own result message (AgentExecutor appends
 * it as a `role: 'tool'` message whose content is
 * `JSON.stringify(toolResult.result)`, and createFixerTool's
 * result shape includes a `patch` field - see fixer.ts).
 */
function extractDelegatedPatch(result: ExecutionResult, toolName: string): string | undefined {
  for (let i = result.messages.length - 1; i >= 0; i--) {
    const message = result.messages[i];
    if (message.role === 'tool' && message.toolName === toolName) {
      try {
        const parsed = JSON.parse(textOf(message));
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
   * Slack signing secret. When set (default: `SLACK_SIGNING_SECRET`), requests to
   * POST /slack/interactions must carry a valid Slack signature or get a 401.
   */
  slackSigningSecret?: string;
  /**
   * Guardrails to run before considering the GitHub PR call. Defaults to
   * handleFixerPatch()'s own defaults (real secretScanCheck + a
   * diff-size cap) when omitted. Exposed here so callers (e.g. LOU-J9's
   * pipeline.eval.ts) can wrap the default patchChecks to observe/record
   * execution order without changing which patchChecks actually run.
   */
  patchChecks?: PatchCheck[];
}

export interface OpsPipelineHandle {
  monitor: MonitorServerHandle;
  slack: { server: http.Server; port: number; close: () => Promise<void> };
  close: () => Promise<void>;
}

/**
 * Registers the fixer delegate tool - flagged as needing approval - and returns
 * the registry the monitor agent (and the Slack resume path) will use.
 */
function buildGatedToolRegistry(provider: LLMProvider): ToolRegistry {
  const fixerAgent = buildFixerAgent();
  const delegateTool = createFixerTool({ agent: fixerAgent, provider });
  // The fixer agent must never run without first passing through the
  // approval gate (this epic's own non-negotiable safety property) -
  // enforced here by flagging the delegate tool itself as needing
  // approval, so AgentExecutor.execute() pauses BEFORE ever calling it.
  const gatedDelegateTool: ToolDescriptor = { ...delegateTool, needsApproval: true };

  const toolRegistry = new ToolRegistry();
  toolRegistry.register(DELEGATE_TOOL_NAME, gatedDelegateTool);
  return toolRegistry;
}

const MONITOR_AGENT = {
  name: 'ops-monitor',
  prompt:
    'You are an ops monitor. When an alert fires, delegate it to the fixer agent via the ' +
    `${DELEGATE_TOOL_NAME} tool.`,
  tools: { [DELEGATE_TOOL_NAME]: { tool: DELEGATE_TOOL_NAME } },
};

/** Everything the Slack interaction handler needs from the pipeline wiring. */
interface SlackRouteContext {
  provider: LLMProvider;
  approvalStore: ApprovalStore;
  toolRegistry: ToolRegistry;
  githubCreatePrTool: ToolDescriptor;
  slackTool: ToolDescriptor;
  channel: string;
  signingSecret?: string;
  patchChecks?: PatchCheck[];
}

/** True when no signing secret is configured, or the request carries a valid Slack signature over the raw body. */
function isAuthenticSlackRequest(req: http.IncomingMessage, raw: string, signingSecret: string | undefined): boolean {
  if (!signingSecret) return true;
  const header = (name: string) => (typeof req.headers[name] === 'string' ? (req.headers[name] as string) : undefined);
  return verifySlackSignature({
    signingSecret,
    timestamp: header('x-slack-request-timestamp'),
    signature: header('x-slack-signature'),
    rawBody: raw,
  });
}

/**
 * Handles one POST /slack/interactions request: resumes the paused run, then -
 * if the fixer produced a patch - sends it through the patch-check-gated PR path.
 */
async function handleSlackInteractionRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: SlackRouteContext
): Promise<void> {
  try {
    const raw = await readBody(req);
    if (!isAuthenticSlackRequest(req, raw, ctx.signingSecret)) {
      sendJson(res, 401, { error: 'Unauthorized' });
      return;
    }
    const payload = parseSlackInteractionBody(raw);
    const approvalId = extractApprovalIdFromInteraction(payload);

    const result = await handleSlackInteraction(payload, {
      approvalStore: ctx.approvalStore,
      toolRegistry: ctx.toolRegistry,
      provider: ctx.provider,
    });

    if (result && approvalId) {
      const patch = extractDelegatedPatch(result, DELEGATE_TOOL_NAME);
      if (patch) {
        await handleFixerPatch(patch, {
          githubCreatePrTool: ctx.githubCreatePrTool,
          slackTool: ctx.slackTool,
          channel: ctx.channel,
          approvalId,
          head: `fix/auto-${approvalId}`,
          patchChecks: ctx.patchChecks,
        });
      }
    }

    sendJson(res, 200, { handled: result !== undefined });
  } catch (error) {
    sendJson(res, 400, { error: (error as Error).message });
  }
}

/**
 * Builds the monitor's onResult hook: when a run pauses awaiting approval,
 * posts the Slack alert carrying the "Fix it" button for that approvalId.
 */
function createApprovalNotifier(
  slackTool: ToolDescriptor,
  channel: string
): NonNullable<StartMonitorServerOptions['onResult']> {
  return async (signal, result) => {
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
  };
}

/** Starts the small server exposing POST /slack/interactions. */
async function startSlackInteractionsServer(
  ctx: SlackRouteContext,
  port: number,
  host: string
): Promise<OpsPipelineHandle['slack']> {
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/slack/interactions') {
      void handleSlackInteractionRequest(req, res, ctx);
      return;
    }
    sendNotFound(res);
  });

  const actualPort = await listenOn(server, port, host);
  return { server, port: actualPort, close: () => closeServer(server) };
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
  const githubCreatePrTool = deps.githubCreatePrTool ?? createMockGithubTool({ log: (m) => console.log(m) }).tool;
  const slackTool = deps.slackTool ?? createMockSlackTool().tool;
  const approvalStore = deps.approvalStore ?? createInMemoryApprovalStore();
  const channel = deps.channel ?? DEFAULT_CHANNEL;
  const toolRegistry = buildGatedToolRegistry(provider);

  const monitor = await startMonitorServer({
    executeOptions: {
      agent: MONITOR_AGENT,
      provider,
      toolRegistry,
      approvalStore,
    },
    host: deps.monitorHost,
    port: deps.monitorPort,
    onResult: createApprovalNotifier(slackTool, channel),
  });

  const slack = await startSlackInteractionsServer(
    {
      provider,
      approvalStore,
      toolRegistry,
      githubCreatePrTool,
      slackTool,
      channel,
      signingSecret: deps.slackSigningSecret ?? process.env.SLACK_SIGNING_SECRET,
      patchChecks: deps.patchChecks,
    },
    deps.slackPort ?? 0,
    deps.slackHost ?? '127.0.0.1'
  );

  return {
    monitor,
    slack,
    close: async () => {
      await monitor.close();
      await slack.close();
    },
  };
}

/**
 * Entry point (`npm run pipeline:demo`): starts both listeners against the
 * in-process mocks, so the demo runs with zero external network access.
 * Guarded so importing this module (tests, other examples) does not bind
 * ports - `process.argv[1]` is the script Node was started with; realpath
 * covers the case where it was invoked through a symlink.
 */
if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  startOpsPipeline({
    monitorPort: Number(process.env.MONITOR_PORT ?? 8787),
    slackPort: Number(process.env.SLACK_PORT ?? 8788),
  })
    .then((handle) => {
      console.log(`ops-pipeline demo is running (mock tools, no external calls):`);
      console.log(`  monitor webhook:       POST http://127.0.0.1:${handle.monitor.port}/webhook`);
      console.log(`  slack interactions:    POST http://127.0.0.1:${handle.slack.port}/slack/interactions`);
      console.log(`Trigger a synthetic error with: npm run pipeline:demo:trigger`);
      const shutdown = () => {
        void handle.close().then(() => process.exit(0));
      };
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
      // Non-interactive runs (piped/closed stdin) shut down once the input
      // stream ends, so `tsx index.ts </dev/null` exits cleanly.
      process.stdin.once('end', shutdown);
      process.stdin.resume();
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}


