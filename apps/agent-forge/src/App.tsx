import './components/layout.css';
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
        <div className="app">
          <Topbar />
          <div className="shell">
            <LeftRail />
            <CanvasArea />
            <Inspector />
          </div>
          <BottomDrawer />
        </div>
      </AppStateProvider>
    </ErrorBoundary>
  );
}
