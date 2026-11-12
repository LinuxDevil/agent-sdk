import type { ReactNode } from 'react';

import type { AgentTab } from '../agents/agentTabs';
import { AgentOverviewTab } from './AgentOverviewTab';
import { CodeTab } from './code/CodeTab';
import { ConfigureTab } from './configure/ConfigureTab';
import { RunsTab } from './runs/RunsTab';
import { SuggestionsTab } from './SuggestionsTab';
import { VersionsTab } from './VersionsTab';

/**
 * Tab bodies by tab; each later ticket adds its entry and adds the tab to
 * `BUILT_AGENT_TABS` in `agents/agentTabs.ts`. 'overview' is A05, 'runs' A11,
 * 'versions' L01, 'configure' A07, 'code' A08, 'suggestions' L11b (R06 adds
 * the suggestion cards inside it).
 */
export const TAB_SCREENS: Partial<Record<AgentTab, () => ReactNode>> = {
  overview: AgentOverviewTab,
  configure: ConfigureTab,
  code: CodeTab,
  runs: RunsTab,
  versions: VersionsTab,
  suggestions: SuggestionsTab,
};
