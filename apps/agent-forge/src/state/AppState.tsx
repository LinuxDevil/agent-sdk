import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { AgentSpec } from '@loushy/build-ai-agent';
import { LocalStorageAgentStore } from '../persistence/LocalStorageAgentStore';
import type { AgentStore, AgentStoreEntry } from '../persistence/AgentStore';
import { graphToSpec } from '../graph/graphToSpec';
import { specToGraph } from '../graph/specToGraph';
import type { AgentGraphSpec } from '../graph/types';
import { graphFromTemplate, type TemplateId } from '../canvas/templates';
import {
  runtimeClient,
  RuntimeApiError,
  type AgentRunStatusPayload,
  type LogEntry,
  type SpanEvent,
  type DebugStatePayload,
  type ChatSessionMeta,
  type ChatSessionRecord,
  type SettingsProfile,
} from '../runtime/runtimeClient';
import { appendLog } from './logReducer';
import { upsertSpan } from './spanReducer';
import { applyChatState, emptyChatState, type ChatState } from './chatReducer';

const AUTOSAVE_DEBOUNCE_MS = 800;

const DEFAULT_SPEC: AgentSpec = {
  name: 'untitled-agent',
  prompt: 'You are a helpful agent.',
  provider: { type: 'mock', model: 'mock-1' },
};

export type RailTab = 'agents' | 'nodes';
export type DrawerTab = 'chat' | 'logs' | 'trace' | 'output' | 'settings';

interface AppState {
  store: AgentStore;
  agentId: string;
  /**
   * The canonical, editable graph for the currently-loaded agent (LOU-M).
   * Every canvas mutation (add/remove/move node, connect/disconnect edge,
   * rename) goes through `setGraph`, never a ReactFlow-only, ephemeral
   * state that could drift from this.
   */
  graph: AgentGraphSpec;
  setGraph: (updater: (graph: AgentGraphSpec) => AgentGraphSpec) => void;
  /**
   * Derived, read-mostly view of `graph` as the SDK's `AgentSpec` (via
   * `graphToSpec()`), kept for components that predate the real canvas
   * (Topbar import/export, the drawer's Output tab) and for persistence.
   * Writing through `setSpec` replaces the whole graph via `specToGraph()`
   * - appropriate for "import a whole new spec file", not for incremental
   * node edits (use `setGraph` for those).
   */
  spec: AgentSpec;
  setSpec: (updater: (spec: AgentSpec) => AgentSpec) => void;
  /** True when there are unsaved changes since the last successful `save()`. */
  dirty: boolean;
  save: () => Promise<void>;
  selectedNodeId: string | undefined;
  setSelectedNodeId: (nodeId: string | undefined) => void;
  railTab: RailTab;
  setRailTab: (tab: RailTab) => void;
  drawerTab: DrawerTab;
  setDrawerTab: (tab: DrawerTab) => void;
  /** Every agent currently known to `store`, refreshed after save/create/switch. */
  agents: AgentStoreEntry[];
  /** Loads a different agent's graph into the canvas - a full state swap, not a visual pan. */
  switchAgent: (id: string) => Promise<void>;
  /** Creates a new agent from a seed template and switches to it. */
  createAgent: (id: string, template: TemplateId) => Promise<void>;
  /**
   * Live run status for the currently-loaded agent (LOU-N), pushed over
   * `WS /agents/:id/stream` and mirrored here for the Topbar/LeftRail
   * status pills. `undefined` until the first status is known (e.g. before
   * the WS subscription's initial push arrives).
   */
  runStatus: AgentRunStatusPayload | undefined;
  /** POSTs the current graph's compiled spec + `input` to `/agents/:id/run`. */
  runAgent: (input: string) => Promise<void>;
  /** POSTs `/agents/:id/stop` - see runtimeClient.ts/runRegistry.ts for what this can and can't interrupt. */
  stopAgent: () => Promise<void>;
  /** Resolves the run's current pending approval, if any, via `/agents/:id/approve`. */
  approveAgent: (approved: boolean, note?: string) => Promise<void>;
  /**
   * Live run status for every saved agent (LOU-N), keyed by agent id -
   * what the LeftRail's agent-list status pills render, replacing LOU-L/M's
   * static "active"/"idle" placeholder. An agent id absent from this map
   * has never reported a status (equivalent to 'idle').
   */
  agentStatuses: Record<string, AgentRunStatusPayload>;

  /**
   * O1: this agent's live log feed (LOU-O), a capped ring buffer reset on
   * every agent switch and on every fresh `runAgent()` call (so an old
   * run's logs don't linger under a new one, matching the mockup's
   * per-run log panel).
   */
  logs: LogEntry[];
  /** O2: this agent's live span list (LOU-O), reset the same way as `logs`. */
  spans: SpanEvent[];
  /** O3: this agent's live step-debugger state (LOU-O), or undefined before the first `/debug` fetch/push. */
  debugState: DebugStatePayload | undefined;
  /** Topbar's "Debug" toggle (O3) - when true, the canvas/inspector expose breakpoint controls. */
  debugMode: boolean;
  setDebugMode: (on: boolean) => void;
  /** Replaces this agent's breakpoint set (O3) - see debugController.ts for the `llm:before`/`tool:<name>:before` key shape. */
  setBreakpoints: (breakpoints: string[]) => Promise<void>;
  /** Resumes a run paused at a breakpoint. */
  continueDebug: () => Promise<void>;
  /** Resumes a run paused at a breakpoint, or arms a pause at the next LLM/tool boundary. */
  stepDebug: () => Promise<void>;
  /** Node (on the canvas) currently highlighted because its log/span is selected in the drawer (O2). */
  highlightedNodeId: string | undefined;
  setHighlightedNodeId: (nodeId: string | undefined) => void;

  /**
   * P1/P2: this agent's live chat transcript - the server's real
   * `Message[]` history (see runRegistry.ts/chatReconcile.ts), pushed over
   * `WS /agents/:id/stream` as `{type:'chat'}` and applied through the pure
   * `applyChatState()` reducer (chatReducer.ts).
   */
  chat: ChatState;
  /** POSTs `text` to `/agents/:id/message` (P1) - see runRegistry.ts's sendMessage() doc comment for continuation semantics. */
  sendChatMessage: (text: string) => Promise<void>;
  /** Set on a failed sendChatMessage()/startNewChat() call (e.g. already running, or paused awaiting approval) - cleared on the next attempt. */
  chatActionError: string | undefined;
  /** P3: metadata for every past (and current) chat session for this agent, newest first. */
  chatSessions: ChatSessionMeta[];
  /** P3: archives the current chat session and starts a fresh, empty one. */
  startNewChat: () => Promise<void>;
  /** P3: a past session's full transcript, loaded for read-only browsing (undefined = viewing the live session). */
  viewedChatSession: ChatSessionRecord | undefined;
  /** P3: loads a past session for read-only viewing in the Chat tab. */
  viewChatSession: (sessionId: string) => Promise<void>;
  /** P3: switches the Chat tab back to the live session. */
  returnToLiveChat: () => void;

  /**
   * R3: the currently-active settings profile (env/provider/deploy-adapter
   * bundle) - what the Topbar's env indicator now renders instead of the
   * old static "local · mock provider" label. `undefined` until the first
   * fetch resolves (e.g. runtime server not reachable yet).
   */
  activeProfile: SettingsProfile | undefined;
  /** Re-fetches `activeProfile` from the server - called after any Settings-tab mutation (key/profile change) so the Topbar reflects it immediately. */
  refreshActiveProfile: () => Promise<void>;
}

const AppStateContext = createContext<AppState | undefined>(undefined);

function deriveSpec(graph: AgentGraphSpec, fallback: AgentSpec): AgentSpec {
  try {
    return graphToSpec(graph);
  } catch {
    // No llm node yet (e.g. mid-edit after deleting it) - keep the last
    // spec that successfully derived rather than crashing the UI.
    return fallback;
  }
}

export function AppStateProvider({ children }: { children: ReactNode }) {
  const store = useMemo(() => new LocalStorageAgentStore(), []);
  const [agentId, setAgentId] = useState('untitled-agent');
  const [graph, setGraphState] = useState<AgentGraphSpec>(() => specToGraph(DEFAULT_SPEC));
  const [dirty, setDirty] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | undefined>(undefined);
  const [railTab, setRailTab] = useState<RailTab>('agents');
  const [drawerTab, setDrawerTab] = useState<DrawerTab>('chat');
  const [agents, setAgents] = useState<AgentStoreEntry[]>([]);
  const lastValidSpec = useRef<AgentSpec>(DEFAULT_SPEC);
  const autosaveTimer = useRef<ReturnType<typeof setTimeout>>();

  const spec = useMemo(() => {
    const derived = deriveSpec(graph, lastValidSpec.current);
    lastValidSpec.current = derived;
    return derived;
  }, [graph]);

  const refreshAgents = useCallback(async () => {
    setAgents(await store.list());
  }, [store]);

  // Load any previously-saved spec for this agent, and the agent list, on mount.
  useEffect(() => {
    let cancelled = false;
    store.load(agentId).then((loaded) => {
      if (!cancelled && loaded) {
        const loadedGraph = specToGraph(loaded);
        setGraphState(loadedGraph);
        setSelectedNodeId(loadedGraph.nodes.find((n) => n.type === 'llm')?.id);
      }
    });
    void refreshAgents();
    return () => {
      cancelled = true;
    };
    // Intentionally runs once on mount only - `switchAgent` handles later
    // agent changes explicitly rather than re-running this on agentId writes.
  }, []);

  const save = useCallback(async () => {
    await store.save(agentId, spec);
    setDirty(false);
    await refreshAgents();
  }, [store, agentId, spec, refreshAgents]);

  const setGraph = useCallback((updater: (graph: AgentGraphSpec) => AgentGraphSpec) => {
    setGraphState((prev) => updater(prev));
    setDirty(true);
  }, []);

  const setSpec = useCallback(
    (updater: (spec: AgentSpec) => AgentSpec) => {
      setGraphState((prev) => specToGraph(updater(deriveSpec(prev, lastValidSpec.current))));
      setSelectedNodeId(undefined);
      setDirty(true);
    },
    []
  );

  // Autosave: debounce writes so we're not hitting localStorage on every
  // node drag frame, but still persist without an explicit Save click.
  useEffect(() => {
    if (!dirty) return;
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    autosaveTimer.current = setTimeout(() => {
      store.save(agentId, spec).then(() => {
        setDirty(false);
        void refreshAgents();
      });
    }, AUTOSAVE_DEBOUNCE_MS);
    return () => {
      if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    };
  }, [spec, dirty, store, agentId, refreshAgents]);

  const switchAgent = useCallback(
    async (id: string) => {
      const loaded = await store.load(id);
      const nextGraph = specToGraph(loaded ?? DEFAULT_SPEC);
      setAgentId(id);
      setGraphState(nextGraph);
      lastValidSpec.current = loaded ?? DEFAULT_SPEC;
      setSelectedNodeId(nextGraph.nodes.find((n) => n.type === 'llm')?.id);
      setDirty(false);
    },
    [store]
  );

  const createAgent = useCallback(
    async (id: string, template: TemplateId) => {
      const nextGraph = graphFromTemplate(template);
      const nextSpec = graphToSpec(nextGraph);
      await store.save(id, nextSpec);
      setAgentId(id);
      setGraphState(nextGraph);
      lastValidSpec.current = nextSpec;
      setSelectedNodeId(nextGraph.nodes.find((n) => n.type === 'llm')?.id);
      setDirty(false);
      await refreshAgents();
    },
    [store, refreshAgents]
  );

  const [runStatus, setRunStatus] = useState<AgentRunStatusPayload | undefined>(undefined);
  const [agentStatuses, setAgentStatuses] = useState<Record<string, AgentRunStatusPayload>>({});
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [spans, setSpans] = useState<SpanEvent[]>([]);
  const [debugState, setDebugState] = useState<DebugStatePayload | undefined>(undefined);
  const [debugMode, setDebugMode] = useState(false);
  const [highlightedNodeId, setHighlightedNodeId] = useState<string | undefined>(undefined);
  const [chat, setChat] = useState<ChatState>(emptyChatState());
  const [chatActionError, setChatActionError] = useState<string | undefined>(undefined);
  const [chatSessions, setChatSessions] = useState<ChatSessionMeta[]>([]);
  const [viewedChatSession, setViewedChatSession] = useState<ChatSessionRecord | undefined>(undefined);
  const [activeProfile, setActiveProfile] = useState<SettingsProfile | undefined>(undefined);

  const refreshActiveProfile = useCallback(async () => {
    try {
      const { activeProfileId, profiles } = await runtimeClient.listSettingsProfiles();
      setActiveProfile(profiles.find((p) => p.id === activeProfileId) ?? profiles[0]);
    } catch {
      // Runtime server may not be running yet - Topbar just keeps showing
      // no env indicator rather than erroring the whole app.
    }
  }, []);

  useEffect(() => {
    void refreshActiveProfile();
  }, [refreshActiveProfile]);

  // Keep one WS subscription per known agent id (for the LeftRail's status
  // pills), added/removed as `agents` (the saved-agent list) changes -
  // rather than per-agent polling, which would need to pick a poll
  // interval that trades off staleness against request volume.
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

  // Subscribe to this agent's live run status over WS whenever the loaded
  // agent changes - a full re-subscribe (not just filtering messages) since
  // the server's stream is already scoped per agent id.
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
    const unsubscribe = runtimeClient.subscribe(agentId, (message) => {
      if (message.type === 'status') setRunStatus(message.payload);
      else if (message.type === 'log') setLogs((prev) => appendLog(prev, message.payload));
      else if (message.type === 'span') setSpans((prev) => upsertSpan(prev, message.payload));
      else if (message.type === 'debug') setDebugState(message.payload);
      else if (message.type === 'chat') setChat((prev) => applyChatState(prev, message.payload));
    });
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

  const runAgent = useCallback(
    async (input: string) => {
      // Reset the log/span feed on every Run click so stale rows from a
      // previous run of this same agent don't linger alongside the new
      // ones (including a checkpoint-resumed run - a fresh feed for it is
      // preferable to conflating it with the aborted run's).
      setLogs([]);
      setSpans([]);
      await runtimeClient.run(agentId, input, spec);
    },
    [agentId, spec]
  );

  const setBreakpoints = useCallback(
    async (breakpoints: string[]) => {
      const next = await runtimeClient.setBreakpoints(agentId, breakpoints);
      setDebugState(next);
    },
    [agentId]
  );

  const continueDebug = useCallback(async () => {
    const next = await runtimeClient.continueRun(agentId);
    setDebugState(next);
  }, [agentId]);

  const stepDebug = useCallback(async () => {
    const next = await runtimeClient.stepRun(agentId);
    setDebugState(next);
  }, [agentId]);

  const stopAgent = useCallback(async () => {
    await runtimeClient.stop(agentId);
  }, [agentId]);

  const approveAgent = useCallback(
    async (approved: boolean, note?: string) => {
      const approvalId = runStatus?.pendingApproval?.approvalId;
      if (!approvalId) {
        throw new Error('approveAgent: no pending approval for this agent');
      }
      await runtimeClient.approve(agentId, approvalId, approved, note);
    },
    [agentId, runStatus]
  );

  const sendChatMessage = useCallback(
    async (text: string) => {
      setChatActionError(undefined);
      try {
        await runtimeClient.sendMessage(agentId, text);
      } catch (error) {
        setChatActionError(error instanceof RuntimeApiError ? error.message : (error as Error).message);
        throw error;
      }
    },
    [agentId]
  );

  const startNewChat = useCallback(async () => {
    setChatActionError(undefined);
    setViewedChatSession(undefined);
    const next = await runtimeClient.newChat(agentId);
    setChat({ sessionId: next.sessionId, messages: next.messages });
    setChatSessions(await runtimeClient.listChats(agentId));
  }, [agentId]);

  const viewChatSession = useCallback(
    async (sessionId: string) => {
      setViewedChatSession(await runtimeClient.loadChatSession(agentId, sessionId));
    },
    [agentId]
  );

  const returnToLiveChat = useCallback(() => {
    setViewedChatSession(undefined);
  }, []);

  const value: AppState = {
    store,
    agentId,
    graph,
    setGraph,
    spec,
    setSpec,
    dirty,
    save,
    selectedNodeId,
    setSelectedNodeId,
    railTab,
    setRailTab,
    drawerTab,
    setDrawerTab,
    agents,
    switchAgent,
    createAgent,
    runStatus,
    runAgent,
    stopAgent,
    approveAgent,
    agentStatuses,
    logs,
    spans,
    debugState,
    debugMode,
    setDebugMode,
    setBreakpoints,
    continueDebug,
    stepDebug,
    highlightedNodeId,
    setHighlightedNodeId,
    chat,
    sendChatMessage,
    chatActionError,
    chatSessions,
    startNewChat,
    viewedChatSession,
    viewChatSession,
    returnToLiveChat,
    activeProfile,
    refreshActiveProfile,
  };

  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
}

export function useAppState(): AppState {
  const ctx = useContext(AppStateContext);
  if (!ctx) throw new Error('useAppState must be used within an AppStateProvider');
  return ctx;
}
