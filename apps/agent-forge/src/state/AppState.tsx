import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { AgentSpec } from '@loushy/build-ai-agent';
import { LocalStorageAgentStore } from '../persistence/LocalStorageAgentStore';
import type { AgentStore, AgentStoreEntry } from '../persistence/AgentStore';
import { graphToSpec } from '../graph/graphToSpec';
import { specToGraph } from '../graph/specToGraph';
import type { AgentGraphSpec } from '../graph/types';
import { graphFromTemplate, type TemplateId } from '../canvas/templates';
import { runtimeClient, type AgentRunStatusPayload } from '../runtime/runtimeClient';

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
    const unsubscribe = runtimeClient.subscribe(agentId, (message) => {
      if (message.type === 'status') setRunStatus(message.payload);
    });
    // Also fetch the current status immediately in case the WS connection
    // is slow to open - avoids a flash of "unknown" status on agent switch.
    runtimeClient
      .status(agentId)
      .then(setRunStatus)
      .catch(() => {
        // The runtime control server may not be running (e.g. the app was
        // opened without `loushy studio`) - status just stays unknown, and
        // Run/Stop surface that as a real error when clicked instead of
        // failing silently here.
      });
    return unsubscribe;
  }, [agentId]);

  const runAgent = useCallback(
    async (input: string) => {
      await runtimeClient.run(agentId, input, spec);
    },
    [agentId, spec]
  );

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
  };

  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
}

export function useAppState(): AppState {
  const ctx = useContext(AppStateContext);
  if (!ctx) throw new Error('useAppState must be used within an AppStateProvider');
  return ctx;
}
