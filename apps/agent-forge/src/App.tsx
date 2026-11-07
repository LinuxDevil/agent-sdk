import './ui/base.css';
import './components/layout.css';
import './components/topbarNarrow.css';
import './screens/agents/agents.css';
import './components/drawer.css';
import { ReactFlowProvider } from '@xyflow/react';
import { AppStateProvider } from './state/AppState';
import { ErrorBoundary } from './components/ErrorBoundary';
import { AppShell } from './shell/AppShell';
import { Screens } from './screens/routes';
import { ToastProvider } from './ui/Toast';
import { AuthorChatProvider } from './author/AuthorChatContext';
import { AuthorPanel } from './author/AuthorPanel';

export function App() {
  return (
    <ErrorBoundary>
      <AppStateProvider>
        {/* Shared by the canvas and the rail's palette (click/keyboard add at the viewport centre). */}
        <ReactFlowProvider>
          <ToastProvider>
            {/* The Author conversation lives above the dock: closing the panel is a pause, not an end. */}
            <AuthorChatProvider>
              <AppShell dock={<AuthorPanel />}>
                <Screens />
              </AppShell>
            </AuthorChatProvider>
          </ToastProvider>
        </ReactFlowProvider>
      </AppStateProvider>
    </ErrorBoundary>
  );
}
