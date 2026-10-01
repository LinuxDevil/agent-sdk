/**
 * Translators from the SDK's execution event streams to the structured
 * `LogEntry` rows the Logs tab renders (LOU-O1). Used by runRegistry.ts.
 */
import { randomUUID } from 'node:crypto';
import type { ExecutionEvent, FlowExecutionEvent } from '@loushy/build-ai-agent';
import type { LogEntry } from '../shared/wireTypes';

/** The event-specific part of a `LogEntry`; id/agentId/timestamp are added by the translators. */
type LogBody = Pick<LogEntry, 'level' | 'phase' | 'message'> & Partial<Pick<LogEntry, 'toolName' | 'detail'>>;

function truncate(text: string | undefined, max = 400): string {
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function toEntry(agentId: string, timestampSource: Date, body: LogBody): LogEntry {
  const timestamp = (timestampSource instanceof Date ? timestampSource : new Date()).toISOString();
  return { id: randomUUID(), agentId, timestamp, ...body };
}

type ExecutionLogBuilders = {
  [K in ExecutionEvent['type']]?: (event: ExecutionEvent, agentId: string) => LogBody;
};

function toolResultLog(event: ExecutionEvent): LogBody {
  const isError = !!event.toolResult?.error;
  return {
    level: isError ? 'error' : 'tool',
    phase: 'tool',
    toolName: event.toolResult?.toolName,
    message: isError
      ? `Tool '${event.toolResult?.toolName}' failed: ${event.toolResult?.error}`
      : `Tool '${event.toolResult?.toolName}' result: ${truncate(JSON.stringify(event.toolResult?.result))}`,
    detail: event.toolResult,
  };
}

const EXECUTION_LOG_BUILDERS: ExecutionLogBuilders = {
  start: (event, agentId) => ({
    level: 'info',
    phase: 'trigger',
    message: `Run started for agent '${event.agentName ?? agentId}'`,
  }),
  'text-complete': (event) => ({
    level: 'info',
    phase: 'llm',
    message: event.text ? `LLM response: ${truncate(event.text)}` : 'LLM response received',
  }),
  'tool-call': (event) => ({
    level: 'tool',
    phase: 'tool',
    toolName: event.toolCall?.function?.name,
    message: `Tool call: ${event.toolCall?.function?.name ?? 'unknown'}`,
    detail: event.toolCall,
  }),
  'tool-result': toolResultLog,
  finish: (event) => ({
    level: 'info',
    phase: event.finishReason === 'awaiting-approval' ? 'approval' : 'trigger',
    message: `Run finished (${event.finishReason})`,
  }),
  error: (event) => ({ level: 'error', phase: 'trigger', message: event.error?.message ?? 'Run failed' }),
};

/**
 * O1: translates one `ExecutionEvent` (the SDK's own execution-phase
 * taxonomy - start/text-delta/text-complete/tool-call/tool-result/finish/
 * error, see AgentExecutor.ts) into zero or more structured `LogEntry`
 * rows. This reuses that taxonomy rather than inventing a second, parallel
 * logging vocabulary - `LogPhase` is a coarser regrouping of the same
 * events (e.g. both 'start' and 'finish' map to phase 'trigger', since
 * those are this pipeline's entry/exit points) plus 'sandbox'/'checkpoint'/
 * 'approval'/'debug' phases used by emitters elsewhere in this file for
 * things ExecutionEvent has no dedicated type for.
 */
export function toLogEntries(agentId: string, event: ExecutionEvent): LogEntry[] {
  const build = EXECUTION_LOG_BUILDERS[event.type];
  return build ? [toEntry(agentId, event.timestamp, build(event, agentId))] : [];
}

type FlowLogBuilders = {
  [K in FlowExecutionEvent['type']]?: (event: FlowExecutionEvent) => LogBody;
};

const FLOW_LOG_BUILDERS: FlowLogBuilders = {
  'flow-start': (event) => ({
    level: 'info',
    phase: 'trigger',
    message: `Flow run started (${event.data?.flowName ?? 'unnamed flow'})`,
  }),
  'llm-call': (event) => ({
    level: 'info',
    phase: 'llm',
    message: `LLM call (model: ${event.data?.model ?? 'unknown'})`,
  }),
  'llm-response': (event) => ({
    level: 'info',
    phase: 'llm',
    message: `LLM response: ${truncate(event.data?.text)}`,
  }),
  'tool-call': (event) => ({
    level: 'tool',
    phase: 'tool',
    toolName: event.data?.tool,
    message: `Tool call: ${event.data?.tool ?? 'unknown'}`,
    detail: event.data,
  }),
  'tool-result': (event) => ({
    level: 'tool',
    phase: 'tool',
    toolName: event.data?.tool,
    message: `Tool '${event.data?.tool}' result: ${truncate(JSON.stringify(event.data?.result))}`,
    detail: event.data,
  }),
  'condition-evaluated': (event) => ({
    level: 'info',
    phase: 'debug',
    message: `Router branch condition '${event.data?.condition ?? '(default)'}' -> ${event.data?.result}`,
  }),
  'flow-complete': () => ({ level: 'info', phase: 'trigger', message: 'Flow run finished' }),
  'flow-error': (event) => ({
    level: 'error',
    phase: 'trigger',
    message: event.error?.message ?? 'Flow run failed',
  }),
};

/**
 * LOU-T3: translates one `FlowExecutionEvent` (`src/flows/FlowExecutor.ts`'s
 * own, unrelated event taxonomy - flow-start/step-start/llm-call/
 * llm-response/tool-call/tool-result/condition-evaluated/loop-iteration/
 * step-complete/flow-complete/flow-error, NOT `AgentExecutor`'s
 * `ExecutionEvent`) into `LogEntry` rows, the same way `toLogEntries()`
 * does for a normal run. This is the extent of debug-console observability
 * for a `FlowExecutor` run today: these land in the Logs tab, but NOT the
 * structured Trace tab (`emitSpan`/`makeTraceExporter` needs a real
 * `TraceExporter`/`Span` stream, which `FlowExecutor.execute()` has no
 * parameter for) or the O3 step-debugger (`DebugSession`'s breakpoints hook
 * into `AgentExecutor`'s `preGenerate`/`postGenerate`/`preToolCall`/
 * `postToolCall` hook points via `hooks`/`sandbox` options that
 * `FlowExecutor.execute()` simply doesn't accept - see its signature). A
 * branching run is therefore only PARTIALLY observable in Agent Forge's
 * debug console: logs yes, trace graph and breakpoint stepping no. Noted
 * here rather than silently left blank; see the LOU-T3 report for the full
 * writeup.
 */
export function toFlowLogEntries(agentId: string, event: FlowExecutionEvent): LogEntry[] {
  const build = FLOW_LOG_BUILDERS[event.type];
  return build ? [toEntry(agentId, event.timestamp, build(event))] : [];
}
