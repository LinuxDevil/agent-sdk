import './components/layout.css';
import { ReactFlowProvider } from '@xyflow/react';
import { AppStateProvider } from './state/AppState';
import { Topbar } from './components/Topbar';
import { LeftRail } from './components/LeftRail';
import { CanvasArea } from './components/CanvasArea';
import { Inspector } from './components/Inspector';
import { BottomDrawer } from './components/BottomDrawer';
import { ErrorBoundary } from './components/ErrorBoundary';

export function App() {
  return (
    <ErrorBoundary>
      <AppStateProvider>
        {/* Eve DUI-F9: shared by the canvas and the rail's palette (click/keyboard add at the viewport centre). */}
        <ReactFlowProvider>
          <div className="app">
            <h1 className="visually-hidden">Agent Forge</h1>
            <Topbar />
            <div className="shell">
              <LeftRail />
              <CanvasArea />
              <Inspector />
            </div>
            <BottomDrawer />
          </div>
        </ReactFlowProvider>
      </AppStateProvider>
    </ErrorBoundary>
  );
}
