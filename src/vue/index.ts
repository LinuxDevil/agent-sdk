/**
 * `@loushy/build-ai-agent/vue` (LOU-P2): the `useLoushyAgent()` composable,
 * and the framework-neutral reducer and stream parser it is built on.
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
  parseEventStream,
  type AgentUIAction,
  type AgentUIState,
  type AgentUIStatus,
  type ApprovalOutcome,
  type UIMessage,
  type UIPendingApproval,
  type UIToolCall,
  type UIToolCallStatus,
} from '../ui';
