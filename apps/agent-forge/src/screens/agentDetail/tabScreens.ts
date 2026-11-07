import type { ReactNode } from 'react';

import type { AgentTab } from '../agents/agentTabs';
import { AgentOverviewTab } from './AgentOverviewTab';

/**
 * Tab bodies by tab; each later ticket adds its entry and adds the tab to
 * `BUILT_AGENT_TABS` in `agents/agentTabs.ts`. Only 'overview' is built (A05).
 */
export const TAB_SCREENS: Partial<Record<AgentTab, () => ReactNode>> = {
  overview: AgentOverviewTab,
};
