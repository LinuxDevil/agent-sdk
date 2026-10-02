/**
 * Translators from the SDK's execution event streams to the structured
 * `LogEntry` rows the Logs tab renders (LOU-O1). Used by runRegistry.ts.
 */
import { randomUUID } from 'node:crypto';
import type { AgentEvent, AgentEventOf, AgentEventType, FlowExecutionEvent } from '@loushy/build-ai-agent';
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

type AgentLogBuilders = {
  [K in AgentEventType]?: (event: AgentEventOf<K>, agentId: string) => LogBody;
};

const AGENT_LOG_BUILDERS: AgentLogBuilders = {
  'run.start': (event, agentId) => ({
    level: 'info',
    phase: 'trigger',
    message: `Run started for agent '${event.agentName || agentId}'`,
  }),
  'text.done': (event) => ({
    level: 'info',
    phase: 'llm',
    message: event.text ? `LLM response: ${truncate(event.text)}` : 'LLM response received',
  }),
  'tool.start': (event) => ({
    level: 'tool',
    phase: 'tool',
    toolName: event.toolName,
    message: `Tool call: ${event.toolName}`,
    detail: event,
  }),
  'tool.done': (event) => ({
    level: 'tool',
    phase: 'tool',
    toolName: event.toolName,
    message: `Tool '${event.toolName}' result: ${truncate(JSON.stringify(event.result))}`,
    detail: event,
  }),
  'tool.error': (event) => ({
    level: 'error',
    phase: 'tool',
    toolName: event.toolName,
    message: `Tool '${event.toolName}' failed: ${event.error.message}`,
    detail: event,
  }),
  'run.done': (event) => ({
    level: 'info',
    phase: event.finishReason === 'awaiting-approval' ? 'approval' : 'trigger',
    message: `Run finished (${event.finishReason})`,
  }),
  error: (event) => ({ level: 'error', phase: 'trigger', message: event.error.message || 'Run failed' }),
};

/**
 * O1 (LOU-D41: from the SDK's `AgentEvent`s): translates one run event into
 * zero or more structured `LogEntry` rows. `LogPhase` is a coarser regrouping
 * of the same events (e.g. both `run.start` and `run.done` map to phase
 * 'trigger', since those are this pipeline's entry/exit points) plus
 * 'sandbox'/'checkpoint'/'approval'/'debug' phases used by emitters
 * elsewhere for things with no dedicated event. A failed run's `run.done`
 * follows its `error`, so it is not logged again.
 */
export function toLogEntries(agentId: string, event: AgentEvent): LogEntry[] {
  if (event.type === 'run.done' && event.finishReason === 'error') return [];
  const build = AGENT_LOG_BUILDERS[event.type] as ((event: AgentEvent, agentId: string) => LogBody) | undefined;
  return build ? [toEntry(agentId, new Date(event.timestamp), build(event, agentId))] : [];
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
 * `AgentEvent`) into `LogEntry` rows, the same way `toLogEntries()`
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
