import { useCallback, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { AgentSpecV2 } from 'lousho';
import { runtimeClient } from '../runtime/runtimeClient';
import type {
  AgentRunStatusPayload,
  LogEntry,
  SpanEvent,
  ToolPin,
} from '../../shared/wireTypes';
import { stableStringify } from '../../shared/stableJson';
import type { ChatState } from './chatReducer';
import type { NodeStates } from './nodeStateReducer';
import type { DrawerTab } from './AppState';
import { lastUserInput } from './pins';

/**
 * The "run from here" pin list (T04): tool results recorded on a node's
 * spans sheet, replayed by the next `runFromHere()` through the run
 * request's `pins` field. Pins live only in this state - they are never
 * persisted and `sendChatMessage`/`runAgent` never send them, so a chat
 * message after "Run from here" carries none.
 */

/** A pin's identity for toggling: same node, tool and (canonical) args - the recorded result may differ per call. */
export function pinKey(pin: ToolPin): string {
  return stableStringify([pin.nodeId, pin.toolName, pin.args ?? null]);
}

interface PinsDeps {
  agentId: string;
  spec: AgentSpecV2;
  chat: ChatState;
  runStatus: AgentRunStatusPayload | undefined;
  /** The stream feed setters `runAgent` resets on every run (logs/spans/node states). */
  setLogs: Dispatch<SetStateAction<LogEntry[]>>;
  setSpans: Dispatch<SetStateAction<SpanEvent[]>>;
  setNodeStates: Dispatch<SetStateAction<NodeStates>>;
  /** Closes the node spans sheet the pin was toggled from. */
  closeNodeSpans: () => void;
  setDrawerTab: (tab: DrawerTab) => void;
}

export function usePins({
  agentId,
  spec,
  chat,
  runStatus,
  setLogs,
  setSpans,
  setNodeStates,
  closeNodeSpans,
  setDrawerTab,
}: PinsDeps) {
  const [pins, setPins] = useState<ToolPin[]>([]);

  const togglePin = useCallback((pin: ToolPin) => {
    setPins((prev) => {
      const key = pinKey(pin);
      return prev.some((p) => pinKey(p) === key) ? prev.filter((p) => pinKey(p) !== key) : [...prev, pin];
    });
  }, []);

  const clearPins = useCallback(() => setPins([]), []);

  const isPinned = useCallback((pin: ToolPin) => pins.some((p) => pinKey(p) === pinKey(pin)), [pins]);

  /**
   * Re-runs the agent from the last user input with the current pins
   * replayed. Resolves without doing anything when there is no user input
   * yet or a run is in flight (the sheet disables the button for both;
   * this is the belt-and-braces guard).
   */
  const runFromHere = useCallback(async () => {
    const input = lastUserInput(chat.messages);
    if (input === undefined) return;
    if (runStatus?.status === 'running' || runStatus?.status === 'paused') return;
    setLogs([]);
    setSpans([]);
    setNodeStates({});
    await runtimeClient.run(agentId, input, spec, pins);
    closeNodeSpans();
    setDrawerTab('test');
  }, [agentId, spec, chat.messages, runStatus, pins, setLogs, setSpans, setNodeStates, closeNodeSpans, setDrawerTab]);

  return { pins, togglePin, clearPins, isPinned, runFromHere };
}
