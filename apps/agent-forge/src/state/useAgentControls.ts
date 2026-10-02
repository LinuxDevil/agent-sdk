import { useCallback, useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { AgentSpec } from '@lousho/build-ai-agent';
import { runtimeClient, RuntimeApiError } from '../runtime/runtimeClient';
import type {
  AgentRunStatusPayload,
  ChatSessionMeta,
  ChatSessionRecord,
  DebugStatePayload,
  LogEntry,
  SettingsProfile,
  SpanEvent,
} from '../../shared/wireTypes';
import type { ChatState } from './chatReducer';

interface RunControlDeps {
  agentId: string;
  spec: AgentSpec;
  runStatus: AgentRunStatusPayload | undefined;
  setLogs: Dispatch<SetStateAction<LogEntry[]>>;
  setSpans: Dispatch<SetStateAction<SpanEvent[]>>;
  setDebugState: Dispatch<SetStateAction<DebugStatePayload | undefined>>;
}

/** Run/stop/approve and the O3 step-debugger actions for `agentId`. */
export function useRunControls({ agentId, spec, runStatus, setLogs, setSpans, setDebugState }: RunControlDeps) {
  const [debugMode, setDebugMode] = useState(false);

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

  return { debugMode, setDebugMode, runAgent, setBreakpoints, continueDebug, stepDebug, stopAgent, approveAgent };
}

interface ChatControlDeps {
  agentId: string;
  setChat: Dispatch<SetStateAction<ChatState>>;
  setChatActionError: Dispatch<SetStateAction<string | undefined>>;
  setChatSessions: Dispatch<SetStateAction<ChatSessionMeta[]>>;
  setViewedChatSession: Dispatch<SetStateAction<ChatSessionRecord | undefined>>;
}

/** P1/P3 chat actions: send a message, start a new session, browse past sessions. */
export function useChatControls({
  agentId,
  setChat,
  setChatActionError,
  setChatSessions,
  setViewedChatSession,
}: ChatControlDeps) {
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

  return { sendChatMessage, startNewChat, viewChatSession, returnToLiveChat };
}

/** R3: the currently-active settings profile, fetched on mount and re-fetchable after Settings mutations. */
export function useActiveProfile() {
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

  return { activeProfile, refreshActiveProfile };
}
