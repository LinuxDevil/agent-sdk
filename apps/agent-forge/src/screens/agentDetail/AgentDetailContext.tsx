import { createContext, useContext } from 'react';

import type { AgentRecord } from '../../../shared/wireTypes';

/** What every tab body of the agent detail screen receives. */
export interface AgentDetailContextValue {
  record: AgentRecord;
  /** Re-fetches the record (after a change another surface made). */
  refresh(): void;
  /** Replaces the record in place (after this screen's own save). */
  setRecord(next: AgentRecord): void;
}

const AgentDetailContext = createContext<AgentDetailContextValue | null>(null);

export { AgentDetailContext };

/** The loaded agent record and its refresh/replace hooks; throws outside the detail screen. */
export function useAgentDetail(): AgentDetailContextValue {
  const value = useContext(AgentDetailContext);
  if (value === null) throw new Error('useAgentDetail must be used inside the agent detail screen');
  return value;
}
