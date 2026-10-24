import './components/layout.css';
import { ReactFlowProvider } from '@xyflow/react';
import { AppStateProvider } from './state/AppState';
import { ErrorBoundary } from './components/ErrorBoundary';
import { AppShell } from './shell/AppShell';
import { Screens } from './screens/routes';
import { ToastProvider } from './ui/Toast';

export function App() {
  return (
    <ErrorBoundary>
      <AppStateProvider>
        {/* Shared by the canvas and the rail's palette (click/keyboard add at the viewport centre). */}
        <ReactFlowProvider>
          <ToastProvider>
            <AppShell>
              <Screens />
            </AppShell>
          </ToastProvider>
        </ReactFlowProvider>
      </AppStateProvider>
    </ErrorBoundary>
  );
}
