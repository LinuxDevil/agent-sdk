import { CircleAlert, SearchX } from 'lucide-react';
import type { ReactNode } from 'react';

import { matchRoute } from '../../router/router';
import { useRoute } from '../../router/useRoute';
import { Skeleton } from '../../ui/Skeleton';
import { EmptyState } from '../../ui/EmptyState';
import { AgentDetailHeader } from './AgentDetailHeader';
import { AgentActionsMenu } from './AgentActionsMenu';
import { AutoDisableNotice, EnabledControl } from './EnabledControl';
import { HeaderLabels } from './LabelsEditor';
import { AgentDetailContext, type AgentDetailContextValue } from './AgentDetailContext';
import { useAgentRecord } from './useAgentRecord';
import { TAB_SCREENS } from './tabScreens';
import { isAgentTab, agentListPath, type AgentTab } from '../agents/agentTabs';
import { activeWorkspace } from '../../workspace/activeWorkspace';
import { HostBanner } from '../../components/HostBanner';
import { hostReadOnlyTitle, useHostStatus } from '../../state/useHostStatus';

/**
 * `#/w/:ws/agents/:id/:tab` - the agent detail screen (A05, workspace-scoped
 * since W04b). Renders bare (no ScreenFrame): the detail header is the
 * page's header. `useScreen`/`agentRedirect` has already sent unbuilt or
 * unknown tabs to the canvas URL, so the tab here is always one
 * `TAB_SCREENS` knows; anything else falls back to the overview.
 */
export function AgentDetailRoute() {
  const { path } = useRoute();
  // The legacy '/agents/:id/:tab' shape is in the list too: `agentRedirect`
  // rewrites it, but a render can land a frame before the redirect does.
  const route = matchRoute(`#${path}`, ['/w/:ws/agents/:id/:tab', '/agents/:id/:tab']);
  const id = route?.params.id ?? '';
  const tabParam = route?.params.tab;
  const tab: AgentTab = tabParam !== undefined && isAgentTab(tabParam) ? tabParam : 'overview';
  const state = useAgentRecord(id);
  // W11c: the workspace's host status - the banner under the header and
  // the read-only title the Run/save controls disable with. Hooks run
  // before the early returns below.
  const host = useHostStatus(route?.params.ws ?? activeWorkspace());

  if (state.loading && state.record === undefined) {
    return (
      <div className="app app-screen agent-detail">
        <header className="agent-detail-header agent-detail-header-loading">
          <div className="agent-detail-loading-top">
            <Skeleton width={44} height={44} radius="var(--radius)" />
            <div>
              <Skeleton width={220} height={20} />
              <Skeleton width={320} height={12} />
            </div>
          </div>
          <span role="status" className="visually-hidden">
            Loading agent
          </span>
        </header>
        <main className="screen-main" />
      </div>
    );
  }

  if (state.error !== undefined) {
    return (
      <div className="app app-screen agent-detail">
        <main className="screen-main">
          <EmptyState
            icon={CircleAlert}
            title="Could not load this agent"
            hint={state.error}
            action={
              <button type="button" className="btn" onClick={state.refresh}>
                Retry
              </button>
            }
          />
        </main>
      </div>
    );
  }

  if (state.notFound || state.record === undefined) {
    return (
      <div className="app app-screen agent-detail">
        <main className="screen-main">
          <EmptyState
            icon={SearchX}
            title="Agent not found"
            hint={`No agent called “${id}” in this workspace.`}
            action={
              <a className="btn" href={`#${agentListPath(activeWorkspace())}`}>
                Back to agents
              </a>
            }
          />
        </main>
      </div>
    );
  }

  const record = state.record;
  const readOnlyTitle = hostReadOnlyTitle(host.status);
  const context: AgentDetailContextValue = { record, refresh: state.refresh, setRecord: state.setRecord, readOnlyTitle };
  const TabScreen = TAB_SCREENS[tab];
  const content: ReactNode = TabScreen ? <TabScreen /> : null;

  return (
    <div className="app app-screen agent-detail">
      <AgentDetailContext.Provider value={context}>
        <AgentDetailHeader
          record={record}
          tab={tab}
          enabledControl={<EnabledControl record={record} />}
          labelsItem={<HeaderLabels record={record} />}
          notices={<AutoDisableNotice record={record} />}
          menu={<AgentActionsMenu record={record} />}
          readOnlyTitle={readOnlyTitle}
        />
        <HostBanner status={host.status} restarting={host.restarting} restartError={host.restartError} onRestart={() => void host.restart()} />
        <main className="screen-main" id="agent-tab-panel">
          {content}
        </main>
      </AgentDetailContext.Provider>
    </div>
  );
}
