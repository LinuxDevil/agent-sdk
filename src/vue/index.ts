/**
 * `@lousho/build-ai-agent/vue` (LOU-P2): the `useLoushoAgent()` composable,
 * and the framework-neutral reducer and stream parser it is built on.
 */

export {
  useLoushoAgent,
  type LocalAgentSource,
  type LoushoAgentSource,
  type RemoteAgentSource,
  type UseLoushoAgentOptions,
  type UseLoushoAgentResult,
} from './useLoushoAgent';
export { useTodos } from './useTodos';
export {
  initialAgentUIState,
  reduceAgentEvents,
  parseEventStream,
  todoView,
  type TodoView,
  type AgentUIAction,
  type AgentUIState,
  type AgentUIStatus,
  type ApprovalOutcome,
  type UIMessage,
  type UIPendingApproval,
  type UIToolCall,
  type UIToolCallStatus,
} from '../ui';
