import type { ReactNode } from 'react';

import type { AgentTab } from '../agents/agentTabs';
import { AgentOverviewTab } from './AgentOverviewTab';
import { CodeTab } from './code/CodeTab';
import { RunsTab } from './runs/RunsTab';
import { VersionsTab } from './VersionsTab';

/**
 * Tab bodies by tab; each later ticket adds its entry and adds the tab to
 * `BUILT_AGENT_TABS` in `agents/agentTabs.ts`. 'overview' is A05, 'runs' A11,
 * 'versions' L01, 'code' A08; 'configure' lands in A07 and 'suggestions'
 * in R06.
 */
export const TAB_SCREENS: Partial<Record<AgentTab, () => ReactNode>> = {
  overview: AgentOverviewTab,
  code: CodeTab,
  runs: RunsTab,
  versions: VersionsTab,
};
