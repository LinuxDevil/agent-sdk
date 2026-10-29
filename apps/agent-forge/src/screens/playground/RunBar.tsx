import { Play, Square } from 'lucide-react';

/** `⌘` on Apple platforms, `Ctrl` elsewhere: the modifier of the run shortcut. */
const MOD_KEY = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘' : 'Ctrl';

interface RunBarProps {
  canRun: boolean;
  running: boolean;
  onRun: () => void;
  onStop: () => void;
}

/** The composer's footer: the Ctrl/Cmd+Enter hint, Stop and the primary Run button. */
export function RunBar({ canRun, running, onRun, onStop }: RunBarProps) {
  return (
    <div className="pg-runbar">
      <span className="pg-shortcut" aria-hidden="true">
        <kbd>{MOD_KEY}</kbd>
        <kbd>Enter</kbd>
        <span>to run</span>
      </span>
      <div className="pg-runbar-actions">
        <button type="button" className="btn btn-sm" disabled={!running} onClick={onStop}>
          <Square aria-hidden="true" fill="currentColor" />
          Stop
        </button>
        <button type="button" className="btn btn-primary" disabled={!canRun} aria-keyshortcuts="Control+Enter Meta+Enter" onClick={onRun}>
          <Play aria-hidden="true" />
          Run
        </button>
      </div>
    </div>
  );
}
