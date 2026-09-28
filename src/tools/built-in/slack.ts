/**
 * Slack alert tool (LOU-J5)
 *
 * Posts an alert message to a Slack channel via an Incoming Webhook, using
 * Slack's Block Kit format with a single interactive "Fix it" button whose
 * `value` carries an approvalId. Clicking that button is meant to resolve a
 * REAL LOU-C ApprovalGate PendingApproval (see resumeAfterApproval() in
 * src/execution/resume.ts, and examples/ops-pipeline/slackInteractions.ts
 * for the interaction-callback route that wires the button click back to
 * it) - this tool itself only sends the message; it does not bypass or
 * reimplement the approval gate.
 *
 * Follows the same ToolDescriptor pattern established in
 * src/tools/built-in/http.ts and github.ts: wraps an AI SDK `tool()` call
 * (not a plain object literal).
 *
 * ## Env var convention (LOU-F8 style)
 *
 * The webhook URL is read from `SLACK_WEBHOOK_URL` by default - following
 * the same "credential lives in an env var named after the provider"
 * convention resolveProvider.ts's PROVIDER_ENV_TABLE uses for LLM
 * providers (e.g. `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`).
 */
import { tool } from 'ai';
import { z } from 'zod';
import { ToolDescriptor } from '../../types';

export const SLACK_WEBHOOK_URL_ENV_KEY = 'SLACK_WEBHOOK_URL';

/**
 * A single Slack Block Kit block - kept intentionally minimal (only the
 * shapes this tool actually emits: section and actions blocks with a
 * button element) rather than modeling the whole Block Kit schema.
 */
export interface SlackBlock {
  type: string;
  text?: { type: string; text: string };
  elements?: Array<{
    type: string;
    text?: { type: string; text: string };
    action_id?: string;
    value?: string;
    style?: string;
  }>;
}

export interface SlackAlertPayload {
  channel: string;
  text: string;
  blocks: SlackBlock[];
}

/**
 * Builds the Slack Block Kit payload for an alert with a "Fix it" button.
 * Exported so callers (and tests) can inspect the exact payload shape
 * without going through a real/mocked HTTP call.
 */
export function buildSlackAlertPayload(
  channel: string,
  message: string,
  approvalId: string
): SlackAlertPayload {
  return {
    channel,
    text: message,
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: message },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Fix it' },
            action_id: 'fix_it',
            value: approvalId,
            style: 'primary',
          },
        ],
      },
    ],
  };
}

export interface SlackToolOptions {
  /** Overrides SLACK_WEBHOOK_URL for testing/injection. */
  webhookUrl?: string;
  /** Overrides the fetch implementation used to POST the payload (testing). */
  fetchImpl?: typeof fetch;
}

/**
 * Posts a pre-built Slack alert payload to the configured Incoming Webhook
 * URL. Exported standalone (in addition to the ToolDescriptor below) so
 * examples/ops-pipeline code that isn't going through AgentExecutor's tool
 * plumbing can still send an alert directly.
 */
export async function postSlackAlert(
  channel: string,
  message: string,
  approvalId: string,
  options: SlackToolOptions = {}
): Promise<{ ok: boolean }> {
  const webhookUrl = options.webhookUrl ?? process.env[SLACK_WEBHOOK_URL_ENV_KEY];
  if (!webhookUrl) {
    throw new Error(
      `Slack tool: no webhook URL configured. Set ${SLACK_WEBHOOK_URL_ENV_KEY} or pass options.webhookUrl.`
    );
  }

  const doFetch = options.fetchImpl ?? fetch;
  const payload = buildSlackAlertPayload(channel, message, approvalId);

  const response = await doFetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Slack tool: webhook post failed: ${response.statusText} - ${errorText}`);
  }

  return { ok: true };
}

/**
 * Creates the Slack alert ToolDescriptor. Requires {channel, message,
 * approvalId} - `approvalId` is the id of a REAL LOU-C PendingApproval
 * (see ApprovalGate.ts) that the "Fix it" button, once clicked, resolves
 * via resumeAfterApproval().
 */
export function createSlackTool(options: SlackToolOptions = {}): ToolDescriptor {
  return {
    displayName: 'Post Slack Alert',
    tool: tool({
      description:
        'Posts an alert to a Slack channel with a "Fix it" button that resumes a pending approval.',
      parameters: z.object({
        channel: z.string().describe('Slack channel to post to (e.g. "#incidents")'),
        message: z.string().describe('Alert message text'),
        approvalId: z.string().describe('The pending approval id the "Fix it" button will resolve'),
      }),
      execute: async ({ channel, message, approvalId }) => {
        return postSlackAlert(channel, message, approvalId, options);
      },
    }),
  };
}

/** Default Slack tool instance, reading SLACK_WEBHOOK_URL at call time. */
export const slackTool: ToolDescriptor = createSlackTool();
