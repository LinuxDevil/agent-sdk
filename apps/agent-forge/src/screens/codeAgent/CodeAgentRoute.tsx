import { useRoute } from '../../router/useRoute';
import { matchRoute } from '../../router/router';
import { CodeAgentScreen } from './CodeAgentScreen';

/**
 * `#/code-agents/:path` - the path segment is the `CodeAgentDir.path` the
 * Agents list encoded with `encodeURIComponent` (`agents%2Fsupport` is one
 * segment); `matchRoute` decodes it back to `agents/support`.
 */
export function CodeAgentRoute() {
  const { path } = useRoute();
  const agentPath = matchRoute(`#${path}`, ['/code-agents/:path'])?.params.path ?? '';
  return <CodeAgentScreen key={agentPath} path={agentPath} />;
}
