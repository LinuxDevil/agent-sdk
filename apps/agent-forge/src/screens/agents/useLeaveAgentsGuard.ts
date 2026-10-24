import { useLayoutEffect, useRef, useState } from 'react';
import { navigate } from '../../router/router';
import { useRoute } from '../../router/useRoute';
import { useAppState } from '../../state/AppState';
import type { ScreenId } from '../routes';
import { confirmDiscardChanges } from './unsavedChanges';

/**
 * The screen to show for `screen`, holding Agents while a move off it waits on
 * the unsaved-changes prompt. Runs before paint, so the next screen never
 * flashes; cancelling restores the Agents hash (replace) so URL and screen agree.
 */
export function useLeaveAgentsGuard(screen: ScreenId): ScreenId {
  const { dirty, agentId } = useAppState();
  // A dependency so the remembered Agents hash follows `#/agents/:id` changes too.
  const route = useRoute();
  const [shown, setShown] = useState(screen);
  const agentsHash = useRef(window.location.hash);
  const leaving = shown === 'agents' && screen !== 'agents';

  useLayoutEffect(() => {
    if (screen === shown) {
      if (screen === 'agents') agentsHash.current = window.location.hash;
      return;
    }
    if (leaving && !confirmDiscardChanges(dirty, agentId)) {
      navigate(agentsHash.current, { replace: true });
      return;
    }
    setShown(screen);
  }, [screen, shown, leaving, dirty, agentId, route]);

  return leaving ? 'agents' : screen;
}
