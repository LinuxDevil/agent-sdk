/**
 * Slack interaction-callback route (LOU-J5).
 *
 * Parses a Slack interaction callback (what Slack POSTs to the
 * `POST /slack/interactions` endpoint when a user clicks the "Fix it"
 * button built by src/tools/built-in/slack.ts's buildSlackAlertPayload()),
 * extracts the approvalId from the clicked button's `value`, and calls the
 * REAL LOU-C6 `resumeAfterApproval()` (src/execution/resume.ts) with that
 * id - genuinely resuming the paused AgentExecutor run through the real
 * ApprovalGate, not a bypass or a reimplementation of it.
 */
import * as http from 'node:http';
import {
  resumeAfterApproval,
  ResumeExecuteOptions,
} from '../../src/execution/resume';
import { ApprovalStore, ExecutionSnapshot, PendingApproval } from '../../src/execution/ApprovalGate';
import { ExecutionResult } from '../../src/execution/AgentExecutor';
import { LLMProvider } from '../../src/providers';
import { ToolRegistry } from '../../src/tools';

/** The subset of Slack's real block_actions interaction callback payload this route reads. */
export interface SlackInteractionPayload {
  type: string;
  actions?: Array<{ action_id: string; value?: string }>;
}

/**
 * Extracts the approvalId (the clicked button's `value`) from a Slack
 * `block_actions` interaction payload whose action_id is 'fix_it'. Returns
 * undefined if the payload isn't a recognized fix_it click.
 */
export function extractApprovalIdFromInteraction(payload: SlackInteractionPayload): string | undefined {
  if (payload.type !== 'block_actions' || !payload.actions) {
    return undefined;
  }
  const fixItAction = payload.actions.find((a) => a.action_id === 'fix_it');
  return fixItAction?.value;
}

/**
 * A simple in-memory ApprovalStore, suitable for the ops-pipeline demo and
 * for tests. Mirrors the pattern src/execution/resume.test.ts uses for its
 * own in-memory store.
 */
export function createInMemoryApprovalStore(): ApprovalStore {
  const records = new Map<string, { pending: PendingApproval; snapshot: ExecutionSnapshot }>();
  return {
    async save(pending, snapshot) {
      records.set(pending.id, { pending, snapshot });
    },
    async resolve(id) {
      const record = records.get(id);
      if (!record) return null;
      records.delete(id);
      return record;
    },
  };
}

export interface SlackInteractionsDeps {
  approvalStore: ApprovalStore;
  toolRegistry: ToolRegistry;
  provider: LLMProvider;
  executeOptions?: ResumeExecuteOptions;
}

/**
 * Handles one parsed Slack interaction payload: extracts the approvalId and
 * resumes the paused run via the REAL resumeAfterApproval(), approving the
 * deferred tool call (clicking "Fix it" is an approval, not a rejection).
 * Returns undefined (without calling resumeAfterApproval at all) if the
 * payload isn't a recognized fix_it click.
 */
export async function handleSlackInteraction(
  payload: SlackInteractionPayload,
  deps: SlackInteractionsDeps
): Promise<ExecutionResult | undefined> {
  const approvalId = extractApprovalIdFromInteraction(payload);
  if (!approvalId) {
    return undefined;
  }

  return resumeAfterApproval(
    { id: approvalId, approved: true },
    deps.approvalStore,
    deps.toolRegistry,
    deps.provider,
    deps.executeOptions ?? {}
  );
}

const MAX_BODY_BYTES = 1024 * 1024; // 1MB

export function readBody(req: http.IncomingMessage): Promise<string> {
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

/**
 * Slack sends interaction callbacks as `application/x-www-form-urlencoded`
 * with the JSON payload under the `payload` field - this parses either that
 * form, or a raw JSON body (for convenience/tests).
 */
export function parseSlackInteractionBody(raw: string): SlackInteractionPayload {
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
