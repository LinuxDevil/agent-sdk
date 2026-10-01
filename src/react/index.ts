/**
 * `@loushy/build-ai-agent/react` (LOU-D15): the `useLoushyAgent()` hook, and
 * the framework-neutral reducer and stream parser it is built on.
 */

export {
  useLoushyAgent,
  type LocalAgentSource,
  type LoushyAgentSource,
  type RemoteAgentSource,
  type UseLoushyAgentOptions,
  type UseLoushyAgentResult,
} from './useLoushyAgent';
export {
  initialAgentUIState,
  reduceAgentEvents,
  type AgentUIAction,
  type AgentUIState,
  type AgentUIStatus,
  type ApprovalOutcome,
  type UIMessage,
  type UIPendingApproval,
  type UIToolCall,
  type UIToolCallStatus,
} from './reducer';
export { parseEventStream } from './parseEventStream';
