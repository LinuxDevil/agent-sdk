/**
 * Mock Slack API (LOU-J8) - same call shape as the REAL Slack tool
 * (src/tools/built-in/slack.ts's createSlackTool()): takes
 * {channel, message, approvalId}, builds the exact same Block Kit payload
 * via the real buildSlackAlertPayload(), and records it instead of
 * POSTing to a real webhook - so the ops-pipeline demo runs with zero
 * external network access.
 */
import { ToolDescriptor } from '../../../src/types';
import { buildSlackAlertPayload, SlackAlertPayload } from '../../../src/tools/built-in/slack';

export interface MockSlackPost {
  channel: string;
  message: string;
  approvalId: string;
  payload: SlackAlertPayload;
}

export interface MockSlackTool {
  tool: ToolDescriptor;
  posts: MockSlackPost[];
}

export function createMockSlackTool(): MockSlackTool {
  const posts: MockSlackPost[] = [];

  const tool: ToolDescriptor = {
    displayName: 'Post Slack Alert (mock)',
    tool: {
      description: 'Mock: posts a Slack alert with a Fix it button',
      parameters: {} as any,
      execute: async ({
        channel,
        message,
        approvalId,
      }: {
        channel: string;
        message: string;
        approvalId: string;
      }) => {
        const payload = buildSlackAlertPayload(channel, message, approvalId);
        posts.push({ channel, message, approvalId, payload });
        return { ok: true };
      },
    } as any,
  };

  return { tool, posts };
}
