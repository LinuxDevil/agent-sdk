/**
 * The framework-neutral pieces behind the UI bindings (`./react`, `./vue`):
 * the reducer, the event-stream parser and the run logic.
 */

export { createAgentRunner } from './agentRunner';
export type {
  AgentCommands,
  LocalAgentSource,
  LoushyAgentOptions,
  LoushyAgentSource,
  RemoteAgentSource,
} from './agentRunner';
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
