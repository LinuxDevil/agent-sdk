import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { AgentHook } from '@lousho/build-ai-agent';

/**
 * The kit's hooks (pointed at by `agent.json`'s `hooks`): the incident audit
 * trail. Every tool call and its outcome is appended to `timeline` (in-memory,
 * readable by anything that shares this module) and - when
 * `INCIDENT_TIMELINE_FILE` is set - to that file as JSON lines, so a deploy
 * keeps a durable record of what the agent did during an incident.
 */

export interface TimelineEntry {
  at: string;
  /** 'call' = invoked; 'approval' = paused for a human; 'result' / 'error' = settled. An approved call re-enters the pipeline, so it records 'call' twice. */
  phase: 'call' | 'approval' | 'result' | 'error';
  toolName: string;
  toolCallId: string;
  sessionId?: string;
  args?: Record<string, unknown>;
  detail?: string;
}

/** Every tool call the agent has made, in order - the in-memory incident timeline. */
export const timeline: TimelineEntry[] = [];

/** Clear the in-memory timeline (tests). */
export function resetTimeline(): void {
  timeline.length = 0;
}

function summarize(result: unknown, error?: string): string | undefined {
  if (error !== undefined) return `error: ${error}`;
  const text = typeof result === 'string' ? result : JSON.stringify(result ?? null);
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

function record(entry: TimelineEntry): void {
  timeline.push(entry);
  const file = process.env.INCIDENT_TIMELINE_FILE;
  if (file === undefined || file === '') return;
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
}

/** Append each tool call and its outcome to the incident timeline. */
export function incidentTimeline(): AgentHook {
  return {
    name: 'incident-timeline',
    preToolCall(ctx) {
      record({ at: new Date().toISOString(), phase: 'call', toolName: ctx.toolName, toolCallId: ctx.toolCallId, ...(ctx.sessionId && { sessionId: ctx.sessionId }), args: { ...ctx.args } });
    },
    postToolCall(ctx, result) {
      record({
        at: new Date().toISOString(),
        phase: result.requiresApproval ? 'approval' : result.error ? 'error' : 'result',
        toolName: ctx.toolName,
        toolCallId: ctx.toolCallId,
        ...(ctx.sessionId && { sessionId: ctx.sessionId }),
        detail: result.requiresApproval ? 'paused for approval' : summarize(result.result, result.error),
      });
    },
  };
}

export default [incidentTimeline()];
