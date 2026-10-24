import { createContext, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { AgentSpec } from '@lousho/build-ai-agent';
import { HttpAgentStore } from '../persistence/HttpAgentStore';
import { runtimeClient } from '../runtime/runtimeClient';
import type { AgentStore, AgentStoreEntry } from '../persistence/AgentStore';
import type { AgentGraphSpec } from '../graph/types';
import type { TemplateId } from '../canvas/templates';
import type {
  AgentRunStatusPayload,
  LogEntry,
  SpanEvent,
  DebugStatePayload,
  ChatSessionMeta,
  ChatSessionRecord,
  SettingsProfile,
} from '../../shared/wireTypes';
import type { ChatState } from './chatReducer';
import { useAgentDocument } from './useAgentDocument';
import { useAgentStatuses, useAgentStream } from './useAgentStream';
import { useActiveProfile, useChatControls, useRunControls } from './useAgentControls';

type RailTab = 'agents' | 'nodes';
export type DrawerTab = 'chat' | 'logs' | 'trace' | 'output' | 'history' | 'settings';

interface AppState {
  store: AgentStore;
  agentId: string;
  /**
   * The canonical, editable graph for the currently-loaded agent.
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
  /** Loads a past session for read-only viewing in the Chat tab. */
  viewChatSession: (sessionId: string) => Promise<void>;
  /** Switches the Chat tab back to the live session. */
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

const AppStateContext = createContext<AppState | undefined>(undefined);

export function AppStateProvider({ children }: { children: ReactNode }) {
  // Agents live in the server workspace (.lousho/agents/), not the browser.
  const store = useMemo(() => new HttpAgentStore(runtimeClient), []);
  const [railTab, setRailTab] = useState<RailTab>('agents');
  const [drawerTab, setDrawerTab] = useState<DrawerTab>('chat');
  const doc = useAgentDocument(store);
  const { agentId, spec } = doc;
  const agentStatuses = useAgentStatuses(doc.agents);
  const stream = useAgentStream(agentId);
  const run = useRunControls({ agentId, spec, ...stream });
  const chatControls = useChatControls({ agentId, spec, ...stream });
  const { activeProfile, refreshActiveProfile } = useActiveProfile();

  const value: AppState = {
    store,
    ...doc,
    railTab,
    setRailTab,
    drawerTab,
    setDrawerTab,
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
