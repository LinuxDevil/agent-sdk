import { useCallback, useEffect, useRef, useState } from 'react';

import { streamPlaygroundRun } from './playgroundClient';
import { IDLE_RUN, STARTED_RUN, applyRunEvent, type RunState } from './runState';
import type { PlaygroundRunBody } from './types';

/** One playground run at a time: `start` streams it (aborting any previous one), `stop` aborts it. */
export function useRun(): { run: RunState; start: (body: PlaygroundRunBody) => void; stop: () => void } {
  const [run, setRun] = useState<RunState>(IDLE_RUN);
  const controller = useRef<AbortController | null>(null);

  const stop = useCallback(() => {
    controller.current?.abort();
    controller.current = null;
    setRun((state) => (state.status === 'running' ? { ...state, status: 'stopped' } : state));
  }, []);

  const start = useCallback((body: PlaygroundRunBody) => {
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    setRun(STARTED_RUN);
    void streamPlaygroundRun(body, (event) => setRun((state) => applyRunEvent(state, event)), abort.signal).then(() => {
      if (controller.current === abort) controller.current = null;
      // A stream that closed without a terminal event (should not happen) still ends the run.
      if (!abort.signal.aborted) setRun((state) => (state.status === 'running' ? { ...state, status: 'stopped' } : state));
    });
  }, []);

  // Leaving the screen aborts the run (closing the connection aborts it server-side too).
  useEffect(() => () => controller.current?.abort(), []);
  return { run, start, stop };
}
