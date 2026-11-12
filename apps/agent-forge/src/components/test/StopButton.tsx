import { useState } from 'react';
import { Square } from 'lucide-react';
import { useAppState } from '../../state/AppState';

/**
 * The Test run bar's Stop control (T06): rendered in `TestRunBar`'s
 * `actions` slot while the agent's run is `running` or `paused` (a run
 * paused on an approval still owns the agent - abort discards the pending
 * approval), and hidden otherwise so an idle bar carries no dead button.
 *
 * The click POSTs `/agents/:id/abort` via `stopAgent()`; while the request
 * is in flight the button reads "Stopping…" and is disabled. The status
 * pill itself flips to `stopped` when the server's status push lands (a
 * running run settles `finishReason: 'aborted'` first, a paused one is
 * marked stopped by the abort call itself). A failed request surfaces as a
 * small error note beside the button and leaves it clickable for a retry.
 */
export function StopButton() {
  const { runStatus, stopAgent } = useAppState();
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const status = runStatus?.status;
  const visible = status === 'running' || status === 'paused';

  const handleStop = () => {
    setError(undefined);
    setStopping(true);
    stopAgent()
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setStopping(false));
  };

  if (!visible) return null;

  return (
    <>
      <button
        type="button"
        className="btn btn-ghost btn-danger test-run-stop"
        onClick={handleStop}
        disabled={stopping}
        aria-label={stopping ? 'Stopping run' : 'Stop run'}
      >
        <Square size={16} strokeWidth={1.75} aria-hidden="true" />
        {stopping ? 'Stopping…' : 'Stop'}
      </button>
      {error !== undefined && (
        <span className="run-error" role="alert">
          {error}
        </span>
      )}
    </>
  );
}
