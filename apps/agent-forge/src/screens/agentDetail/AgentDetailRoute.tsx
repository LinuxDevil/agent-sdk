import { matchRoute } from '../../router/router';
import { useRoute } from '../../router/useRoute';

/**
 * `#/agents/:id/:tab` - the agent detail screen. Renders nothing yet: every tab
 * that would land here is unknown or unbuilt, so `useScreen` has already
 * replaced the hash with the canvas URL. A05 fills this in with the detail
 * header and the tab's screen, keyed on the `{ id, tab }` params read here.
 */
export function AgentDetailRoute() {
  const { path } = useRoute();
  const route = matchRoute(`#${path}`, ['/agents/:id/:tab']);
  void route;
  return null;
}
