import './ui/base.css';
import './components/layout.css';
import './components/topbarNarrow.css';
import './screens/agents/agents.css';
import './components/drawer.css';
import { ReactFlowProvider } from '@xyflow/react';
import { AppStateProvider } from './state/AppState';
import { WorkspacesProvider, useWorkspaces } from './workspace/WorkspacesProvider';
import { ErrorBoundary } from './components/ErrorBoundary';
import { AppShell } from './shell/AppShell';
import { Screens } from './screens/routes';
import { ToastProvider } from './ui/Toast';
import { AuthorChatProvider } from './author/AuthorChatContext';
import { AuthorPanel } from './author/AuthorPanel';
import { AuthorRouteFocus } from './author/useRouteFocus';

/** Says so when `GET /workspaces` failed, so requests silently hitting the launch workspace don't go unnoticed (W04a). */
function WorkspaceErrorNotice() {
  const { error } = useWorkspaces();
  if (error === undefined) return null;
  return (
    <div className="connection-banner" role="alert">
      Could not load the workspace list: {error}
    </div>
  );
}

export function App() {
  return (
    <ErrorBoundary>
      {/* Outermost: every request below picks its workspace from this context (W04a). */}
      <WorkspacesProvider>
      <AppStateProvider>
        {/* Shared by the canvas and the rail's palette (click/keyboard add at the viewport centre). */}
        <ReactFlowProvider>
          <ToastProvider>
            {/* The Author conversation lives above the dock: closing the panel is a pause, not an end. */}
            <AuthorChatProvider>
              {/* Keeps the composer focus chip on the agent on screen (AA19). */}
              <AuthorRouteFocus />
              <AppShell dock={<AuthorPanel />}>
                <WorkspaceErrorNotice />
                <Screens />
              </AppShell>
            </AuthorChatProvider>
          </ToastProvider>
        </ReactFlowProvider>
      </AppStateProvider>
      </WorkspacesProvider>
    </ErrorBoundary>
  );
}
