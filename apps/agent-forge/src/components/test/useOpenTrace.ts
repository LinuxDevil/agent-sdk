import { useAppState } from '../../state/AppState';
import { lastRunTraceId } from '../RunStatus';
import { navigate } from '../../router/router';

/**
 * The builder's "Open trace" action, shared by the Topbar's narrow More menu
 * and available to the Test pane's run bar: the latest run's trace id - the
 * status' own, else the live span feed's root (see `lastRunTraceId`) - and a
 * handler that opens its `/traces/<id>` route, the same destination the wide
 * Topbar's trace link points at.
 */
export function useOpenTrace(): { traceId: string | undefined; openTrace: () => void } {
  const { runStatus, spans } = useAppState();
  const traceId = lastRunTraceId(runStatus, spans);
  const openTrace = () => {
    if (traceId !== undefined) navigate(`/traces/${encodeURIComponent(traceId)}`);
  };
  return { traceId, openTrace };
}
