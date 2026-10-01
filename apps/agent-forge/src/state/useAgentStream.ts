import { useEffect, useState } from 'react';
import { runtimeClient } from '../runtime/runtimeClient';
import type {
  AgentRunStatusPayload,
  ChatSessionMeta,
  ChatSessionRecord,
  DebugStatePayload,
  LogEntry,
  SpanEvent,
  StreamMessage,
} from '../../shared/wireTypes';
import type { AgentStoreEntry } from '../persistence/AgentStore';
import { appendLog } from './logReducer';
import { upsertSpan } from './spanReducer';
import { applyChatState, emptyChatState } from './chatReducer';

type StreamHandlers = {
  [K in StreamMessage['type']]?: (payload: Extract<StreamMessage, { type: K }>['payload']) => void;
};

/** Routes one WS frame to the handler registered for its `type` (unhandled types, e.g. raw `event`s, are ignored). */
function dispatchStreamMessage(handlers: StreamHandlers, message: StreamMessage): void {
  const handler = handlers[message.type] as ((payload: StreamMessage['payload']) => void) | undefined;
  handler?.(message.payload);
}

/**
 * One live-status WS subscription per known agent id (for the LeftRail's
 * status pills), added/removed as `agents` (the saved-agent list) changes -
 * rather than per-agent polling, which would need to pick a poll
 * interval that trades off staleness against request volume.
 */
export function useAgentStatuses(agents: AgentStoreEntry[]): Record<string, AgentRunStatusPayload> {
  const [agentStatuses, setAgentStatuses] = useState<Record<string, AgentRunStatusPayload>>({});

  useEffect(() => {
    const unsubscribes = agents.map((entry) =>
      runtimeClient.subscribe(entry.id, (message) => {
        if (message.type !== 'status') return;
        setAgentStatuses((prev) => ({ ...prev, [entry.id]: message.payload }));
      })
    );
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
    // Only the *set* of agent ids matters for (re)subscribing, not object
    // identity of `agents` itself (which changes on every save/autosave) -
    // so this intentionally depends on the joined id list below rather
    // than `agents` itself.
  }, [agents.map((a) => a.id).join(',')]);

  return agentStatuses;
}

/**
 * Live stream-derived state for the currently-loaded agent: run status, the
 * log/span feeds, step-debugger state, chat transcript + session list.
 * Subscribes over WS whenever the loaded agent changes - a full re-subscribe
 * (not just filtering messages) since the server's stream is already scoped
 * per agent id. Setters are exposed for the control hooks that also write
 * this state (run resets the feeds, chat actions swap sessions, ...).
 */
export function useAgentStream(agentId: string) {
  const [runStatus, setRunStatus] = useState<AgentRunStatusPayload | undefined>(undefined);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [spans, setSpans] = useState<SpanEvent[]>([]);
  const [debugState, setDebugState] = useState<DebugStatePayload | undefined>(undefined);
  const [highlightedNodeId, setHighlightedNodeId] = useState<string | undefined>(undefined);
  const [chat, setChat] = useState(emptyChatState());
  const [chatActionError, setChatActionError] = useState<string | undefined>(undefined);
  const [chatSessions, setChatSessions] = useState<ChatSessionMeta[]>([]);
  const [viewedChatSession, setViewedChatSession] = useState<ChatSessionRecord | undefined>(undefined);

  useEffect(() => {
    setRunStatus(undefined);
    setLogs([]);
    setSpans([]);
    setDebugState(undefined);
    setHighlightedNodeId(undefined);
    setChat(emptyChatState());
    setChatActionError(undefined);
    setChatSessions([]);
    setViewedChatSession(undefined);

    const handlers: StreamHandlers = {
      status: setRunStatus,
      log: (entry) => setLogs((prev) => appendLog(prev, entry)),
      span: (span) => setSpans((prev) => upsertSpan(prev, span)),
      debug: setDebugState,
      chat: (payload) => setChat((prev) => applyChatState(prev, payload)),
    };
    const unsubscribe = runtimeClient.subscribe(agentId, (message) => dispatchStreamMessage(handlers, message));
    runtimeClient
      .listChats(agentId)
      .then(setChatSessions)
      .catch(() => {});
    // Also fetch the current status/debug-state immediately in case the WS
    // connection is slow to open - avoids a flash of "unknown" status (or a
    // stale breakpoint list) on agent switch.
    runtimeClient
      .status(agentId)
      .then(setRunStatus)
      .catch(() => {
        // The runtime control server may not be running (e.g. the app was
        // opened without `loushy studio`) - status just stays unknown, and
        // Run/Stop surface that as a real error when clicked instead of
        // failing silently here.
      });
    runtimeClient.debugState(agentId).then(setDebugState).catch(() => {});
    return unsubscribe;
  }, [agentId]);

  return {
    runStatus,
    logs,
    setLogs,
    spans,
    setSpans,
    debugState,
    setDebugState,
    highlightedNodeId,
    setHighlightedNodeId,
    chat,
    setChat,
    chatActionError,
    setChatActionError,
    chatSessions,
    setChatSessions,
    viewedChatSession,
    setViewedChatSession,
  };
}
