/**
 * `getTrace` (PLAN §8.2, AA20): one run's trace file as the condensed
 * step list the Author reads before proposing a fix (AA05's edit
 * workflow). Reads under the session workspace's root
 * (`(await deps.workspace()).ref.root`, the §19.3 seam) through the same
 * `traceStore` helpers the Trace tab's routes use - the id is validated
 * before it can reach a path, and the file lives under
 * `.lousho/agents/<id>/traces`. With `agentId` the lookup is scoped;
 * without it every saved agent's folder is tried in turn.
 */
import { defineTool } from 'lousho';
import { z } from 'zod';
import { isValidTraceId, readAgentTrace } from '../../traceStore';
import { isValidAgentId } from '../../../shared/agentId';
import type { SpanEvent } from '../../../shared/wireTypes';
import type { AuthorToolFailure } from '../../../shared/authorWire';
import type { AuthorToolFactory } from './index';
import { condenseTrace, type GetTraceOutput } from './condenseTrace';
import { guardedToolCall, toolFailure } from './failure';

/** The agent whose trace folder holds `traceId`, plus its spans; undefined when none does. */
async function findTrace(
  baseDir: string,
  agentIds: readonly string[],
  traceId: string
): Promise<{ agentId: string; spans: SpanEvent[] } | undefined> {
  for (const agentId of agentIds) {
    const spans = await readAgentTrace(baseDir, agentId, traceId);
    if (spans.length > 0) return { agentId, spans };
  }
  return undefined;
}

/** AA20's getTrace: a run's trace as model/tool/error steps with cost. */
export const getTraceTool: AuthorToolFactory = (_turn, deps) =>
  defineTool({
    name: 'getTrace',
    description:
      "Read a run's trace as a short list of model calls, tool calls and errors, with cost. Use the traceId from runDraft or one the user gave you.",
    input: z.object({
      traceId: z.string().min(1).max(128).describe('The trace id.'),
      agentId: z
        .string()
        .min(1)
        .max(128)
        .optional()
        .describe('The agent that ran it. Omit to search every agent.'),
    }),
    execute: ({ traceId, agentId }) =>
      guardedToolCall('getTrace', async (): Promise<GetTraceOutput | AuthorToolFailure> => {
        if (!isValidTraceId(traceId)) {
          return toolFailure(
            'INVALID_INPUT',
            `Trace id "${traceId}" is not a valid trace id.`,
            'That is not a trace id.',
            'Use the traceId from a runDraft result or one the user gave you.'
          );
        }
        // agentId becomes a filesystem path segment in agentTraceDir - same
        // validation every :id route applies before it can reach path.join.
        if (agentId !== undefined && !isValidAgentId(agentId)) {
          return toolFailure(
            'INVALID_INPUT',
            `Agent id "${agentId}" is not a valid agent id.`,
            'That is not an agent id.',
            'Call listAgents and copy an id from it.'
          );
        }
        const workspace = await deps.workspace();
        const baseDir = workspace.ref.root;
        const candidates = agentId !== undefined ? [agentId] : workspace.repo.listIds();
        const found = await findTrace(baseDir, candidates, traceId);
        if (found === undefined) {
          return toolFailure(
            'TRACE_NOT_FOUND',
            `No trace "${traceId}" found${agentId !== undefined ? ` for agent "${agentId}"` : ''}.`,
            "That run's trace isn't available.",
            'Use the traceId from a runDraft result or one the user gave you.'
          );
        }
        return { ok: true, traceId, agentId: found.agentId, ...condenseTrace(found.spans) };
      }),
  });
