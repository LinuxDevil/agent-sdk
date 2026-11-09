import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { AgentSpecV2 } from 'lousho';
import { mergeProposal, type ProposalOverlay } from '../graph/v2/proposal';
import { HttpAgentStore } from '../persistence/HttpAgentStore';
import { runtimeClient } from '../runtime/runtimeClient';
import type { AgentStore } from '../persistence/AgentStore';
import type { Graph, GraphEdge } from '../graph/v2/types';
import type { TemplateId } from '../canvas/templates';
import type { AgentListItem } from '../../shared/wireTypes';
import type {
  AgentRunStatusPayload,
  LogEntry,
  SpanEvent,
  DebugStatePayload,
  ChatSessionMeta,
  ChatSessionRecord,
  SettingsProfile,
  VersionListItem,
} from '../../shared/wireTypes';
import type { ChatState } from './chatReducer';
import type { NodeStates } from './nodeStateReducer';
import { useAgentDocument } from './useAgentDocument';
import { agentRouteId } from '../screens/agents/agentRoute';
import { useAgentStatuses, useAgentStream } from './useAgentStream';
import { useActiveProfile, useChatControls, useRunControls } from './useAgentControls';

type RailTab = 'agents' | 'nodes';
export type DrawerTab = 'test' | 'logs' | 'trace' | 'output' | 'history' | 'settings';

interface AppState {
  store: AgentStore;
  agentId: string;
  /**
   * The canonical, editable graph for the currently-loaded agent.
   * Every canvas mutation (add/remove/move node, connect/disconnect edge,
   * rename) goes through `setGraph`, never a ReactFlow-only, ephemeral
   * state that could drift from this.
   */
  graph: Graph;
  setGraph: (updater: (graph: Graph) => Graph) => void;
  /**
   * Derived, read-mostly view of `graph` as the SDK's `AgentSpecV2` (via
   * `graphToSpec()`), kept for components that read the spec shape
   * (Topbar import/export, the drawer's Output tab) and for persistence.
   * Writing through `setSpec` replaces the whole graph via `specToGraph()`
   * - appropriate for "import a whole new spec file", not for incremental
   * node edits (use `setGraph` for those).
   */
  spec: AgentSpecV2;
  setSpec: (updater: (spec: AgentSpecV2) => AgentSpecV2) => void;
  /** The canvas's edges, derived from `graph` by `deriveEdges()` (edges are never stored). */
  edges: GraphEdge[];
  /** Graph node id → the id `specToGraph(spec)` gives it today, from the same `graphToSpec` call as `spec`. */
  nodeIdMap: Record<string, string>;
  /**
   * The proposal overlay (C21): an Agent Author proposal spec shown on top
   * of the canvas — added nodes dashed, removed faded, changed marked —
   * while `graph` itself stays untouched. `undefined` = normal editing.
   */
  proposal: ProposalOverlay | undefined;
  /** Shows `p` as the canvas overlay (the canvas turns read-only until `hideProposal`). */
  showProposal: (p: ProposalOverlay) => void;
  /** Clears the overlay; the canvas returns to `graph` with nothing written. */
  hideProposal: () => void;
  /**
   * What the canvas and Inspector render: `graph`, or `mergeProposal(graph,
   * proposal.spec, layout)` while a proposal is shown. Never persisted —
   * `graphToSpec(displayGraph)` is the proposed spec, `graph` is unchanged.
   */
  displayGraph: Graph;
  /** True when there are unsaved changes since the last successful `save()`. */
  dirty: boolean;
  save: () => Promise<void>;
  /**
   * The explicit "Save version" (the Topbar's Save button and Ctrl/Cmd+S):
   * `save()` (the working-copy PUT, same as autosave) then
   * `POST /agents/:id/versions`. Resolves to the written item when a
   * version was captured, `undefined` when the working copy already
   * matched the latest version (the route's 200 no-op). Rejects on
   * failure - the caller's error surface handles it.
   */
  saveVersion: () => Promise<VersionListItem | undefined>;
  /**
   * The version number the most recent `saveVersion()` reported - the
   * `v<n>` of the "No changes since" toast (the server's 200 answer
   * carries the latest item, so this is always current after a call).
   * `null` before the first `saveVersion()`.
   */
  latestVersion: number | null;
  selectedNodeId: string | undefined;
  setSelectedNodeId: (nodeId: string | undefined) => void;
  railTab: RailTab;
  setRailTab: (tab: RailTab) => void;
  drawerTab: DrawerTab;
  setDrawerTab: (tab: DrawerTab) => void;
  /** Every agent currently known to `store`, refreshed after save/create/switch. */
  agents: AgentListItem[];
  /** False until the first `agents` fetch (and opening the initial agent) has finished, failed included. */
  agentsLoaded: boolean;
  /** Loads a different agent's graph into the canvas - a full state swap, not a visual pan. */
  switchAgent: (id: string) => Promise<void>;
  /** Creates a new agent from a seed template and switches to it. */
  createAgent: (id: string, template: TemplateId) => Promise<void>;
  /** Renames a saved agent (its spec moves to the new id; run history stays under the old one). */
  renameAgent: (fromId: string, toId: string) => Promise<void>;
  /** Deletes a saved agent via `DELETE /agents/:id`. */
  deleteAgent: (id: string) => Promise<void>;
  /** False after the live WebSocket closed (studio server down or restarted), until it reconnects. */
  connected: boolean;
  /**
   * Live run status for the currently-loaded agent, pushed over
   * `WS /agents/:id/stream` and mirrored here for the Topbar/LeftRail
   * status pills. `undefined` until the first status is known (e.g. before
   * the WS subscription's initial push arrives).
   */
  runStatus: AgentRunStatusPayload | undefined;
  /**
   * The latest `node` frame per canvas node id for the current run -
   * the status overlay's feed (canvas/nodeStatus.ts). Reset on agent
   * switch, on each `runAgent()` call and on a new run's first
   * `running` status.
   */
  nodeStates: NodeStates;
  /** POSTs the current graph's compiled spec + `input` to `/agents/:id/run`. */
  runAgent: (input: string) => Promise<void>;
  /** POSTs `/agents/:id/stop` - see runtimeClient.ts/runRegistry.ts for what this can and can't interrupt. */
  stopAgent: () => Promise<void>;
  /** Resolves the run's current pending approval, if any, via `/agents/:id/approve`. */
  approveAgent: (approved: boolean, note?: string) => Promise<void>;
  /**
   * Live run status for every saved agent, keyed by agent id -
   * what the LeftRail's agent-list status pills render, replacing the
   * static "active"/"idle" placeholder. An agent id absent from this map
   * has never reported a status (equivalent to 'idle').
   */
  agentStatuses: Record<string, AgentRunStatusPayload>;

  /**
   * This agent's live log feed, a capped ring buffer reset on
   * every agent switch and on every fresh `runAgent()` call (so an old
   * run's logs don't linger under a new one, matching the mockup's
   * per-run log panel).
   */
  logs: LogEntry[];
  /** This agent's live span list, reset the same way as `logs`. */
  spans: SpanEvent[];
  /** This agent's live step-debugger state, or undefined before the first `/debug` fetch/push. */
  debugState: DebugStatePayload | undefined;
  /** Topbar's "Debug" toggle - when true, the canvas/inspector expose breakpoint controls. */
  debugMode: boolean;
  setDebugMode: (on: boolean) => void;
  /** Replaces this agent's breakpoint set - see debugController.ts for the `llm:before`/`tool:<name>:before` key shape. */
  setBreakpoints: (breakpoints: string[]) => Promise<void>;
  /** Resumes a run paused at a breakpoint. */
  continueDebug: () => Promise<void>;
  /** Resumes a run paused at a breakpoint, or arms a pause at the next LLM/tool boundary. */
  stepDebug: () => Promise<void>;
  /** Node (on the canvas) currently highlighted because its log/span is selected in the drawer. */
  highlightedNodeId: string | undefined;
  setHighlightedNodeId: (nodeId: string | undefined) => void;

  /**
   * This agent's live chat transcript - the server's real
   * `Message[]` history (see runRegistry.ts/chatReconcile.ts), pushed over
   * `WS /agents/:id/stream` as `{type:'chat'}` and applied through the pure
   * `applyChatState()` reducer (chatReducer.ts).
   */
  chat: ChatState;
  /** POSTs `text` to `/agents/:id/message` - see runRegistry.ts's sendMessage() doc comment for continuation semantics. */
  sendChatMessage: (text: string) => Promise<void>;
  /** Set on a failed sendChatMessage()/startNewChat() call (e.g. already running, or paused awaiting approval) - cleared on the next attempt. */
  chatActionError: string | undefined;
  /** Metadata for every past (and current) chat session for this agent, newest first. */
  chatSessions: ChatSessionMeta[];
  /** Archives the current chat session and starts a fresh, empty one. */
  startNewChat: () => Promise<void>;
  /** A past session's full transcript, loaded for read-only browsing (undefined = viewing the live session). */
  viewedChatSession: ChatSessionRecord | undefined;
  /** Loads a past session for read-only viewing in the Test tab. */
  viewChatSession: (sessionId: string) => Promise<void>;
  /** Switches the Test tab back to the live session. */
  returnToLiveChat: () => void;

  /**
   * The currently-active settings profile (env/provider/deploy-adapter
   * bundle) - what the Topbar's env indicator now renders instead of the
   * old static "local · mock provider" label. `undefined` until the first
   * fetch resolves (e.g. runtime server not reachable yet).
   */
  activeProfile: SettingsProfile | undefined;
  /** Re-fetches `activeProfile` from the server - called after any Settings-tab mutation (key/profile change) so the Topbar reflects it immediately. */
  refreshActiveProfile: () => Promise<void>;
}

declare global {
  interface Window {
    /** Dev-only manual trigger for the proposal overlay (C21); set by AppStateProvider under `import.meta.env.DEV`. */
    __forgeShowProposal?: (spec: AgentSpecV2) => void;
  }
}

const AppStateContext = createContext<AppState | undefined>(undefined);

export function AppStateProvider({ children }: { children: ReactNode }) {
  // Agents live in the server workspace (.lousho/agents/), not the browser.
  const store = useMemo(() => new HttpAgentStore(runtimeClient), []);
  const [railTab, setRailTab] = useState<RailTab>('agents');
  const [drawerTab, setDrawerTab] = useState<DrawerTab>('test');
  // A reload of an agents URL (`#/agents/:id`, `#/agents/:id/canvas`, `#/agents/:id/:tab`) reopens that agent.
  const [initialAgentId] = useState(() => agentRouteId(window.location.hash));
  const doc = useAgentDocument(store, initialAgentId);
  const { agentId, spec, save, graph, layout, nodeIdMap } = doc;
  const [proposal, setProposal] = useState<ProposalOverlay | undefined>(undefined);
  const showProposal = useCallback((p: ProposalOverlay) => setProposal(p), []);
  const hideProposal = useCallback(() => setProposal(undefined), []);
  // Memoised on (graph, proposal): mergeProposal is pure and cheap, and the
  // canvas rebuilds its node list from this on every render.
  const displayGraph = useMemo(
    () => (proposal === undefined ? graph : mergeProposal(graph, proposal.spec, layout, nodeIdMap)),
    [graph, proposal, layout, nodeIdMap]
  );
  // A ref (not state) so a caller reading `latestVersion` after `await
  // saveVersion()` sees the version that call just reported, not the one
  // captured when its closure was created.
  const latestVersionRef = useRef<number | null>(null);
  const saveVersion = useCallback(async (): Promise<VersionListItem | undefined> => {
    await save();
    const { item, created } = await runtimeClient.saveVersion(agentId);
    latestVersionRef.current = item.version;
    return created ? item : undefined;
  }, [save, agentId]);
  const agentStatuses = useAgentStatuses(doc.agents);
  const stream = useAgentStream(agentId);
  const run = useRunControls({ agentId, spec, ...stream });
  const chatControls = useChatControls({ agentId, spec, ...stream });
  const { activeProfile, refreshActiveProfile } = useActiveProfile();

  // Dev-only manual trigger for the proposal overlay (AA18 wires the real
  // one): `window.__forgeShowProposal(spec)` in a dev build.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    window.__forgeShowProposal = (spec) => showProposal({ proposalId: 'dev', spec });
    return () => {
      delete window.__forgeShowProposal;
    };
  }, [showProposal]);

  const value: AppState = {
    store,
    ...doc,
    proposal,
    showProposal,
    hideProposal,
    displayGraph,
    saveVersion,
    get latestVersion() {
      return latestVersionRef.current;
    },
    railTab,
    setRailTab,
    drawerTab,
    setDrawerTab,
    // A proposal overlay belongs to the document it was made for: switching,
    // creating, renaming or deleting an agent clears it.
    switchAgent: async (id: string) => {
      setProposal(undefined);
      return doc.switchAgent(id);
    },
    createAgent: async (id: string, template: TemplateId) => {
      setProposal(undefined);
      return doc.createAgent(id, template);
    },
    renameAgent: async (fromId: string, toId: string) => {
      setProposal(undefined);
      return doc.renameAgent(fromId, toId);
    },
    deleteAgent: async (id: string) => {
      setProposal(undefined);
      return doc.deleteAgent(id);
    },
    ...run,
    agentStatuses,
    ...stream,
    ...chatControls,
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
