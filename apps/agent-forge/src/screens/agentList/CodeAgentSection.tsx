import type { CodeAgentDir } from '../../../shared/wireTypes';
import { AgentTile } from '../../ui/AgentTile';

/**
 * X06b: the "In your code" section under the agents grid - one row per
 * agent directory X06a found in the workspace. A row opens the read-only
 * code-agent canvas (`#/code-agents/<encodeURIComponent(path)>`).
 */
export function CodeAgentSection({ dirs }: { dirs: CodeAgentDir[] }) {
  if (dirs.length === 0) return null;
  return (
    <section className="agents-code-section" aria-labelledby="agents-code-title">
      <h2 id="agents-code-title" className="agents-code-title">
        In your code
      </h2>
      <p className="agents-code-hint">Agent directories in this workspace. Open one to see it on the canvas.</p>
      <ul className="agents-code-list">
        {dirs.map((dir) => (
          <li key={dir.path} className="agents-code-row">
            <a href={`#/code-agents/${encodeURIComponent(dir.path)}`}>
              <AgentTile id={dir.path} size="sm" />
              <span className="agents-code-name">{dir.name}</span>
              <code className="agents-code-path">{dir.path}</code>
              <span className="chip">{dir.configFile}</span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
