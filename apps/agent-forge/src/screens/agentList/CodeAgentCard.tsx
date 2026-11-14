/**
 * One code-defined agent as a card in the agents list (W08b): the A03
 * card's look minus everything mutable - no switch, no menu, like the
 * observed card (W07b). The whole card opens `#/w/<ws>/code-agents/<path>`
 * through the name link's overlay; the link's aria-label says "defined in
 * code" so screen readers don't mistake it for an editable Studio agent.
 * `workspaceName` renders the workspace chip in all-workspaces mode only.
 */
import { Folder } from 'lucide-react';

import type { CodeAgentItem } from '../../../shared/wireTypes';
import { AgentTile } from '../../ui/AgentTile';
import { codeAgentPath } from '../codeAgent/codeAgentRoute';
import '../../ui/tileCard.css';
import './agentCard.css';
import './codeAgentCard.css';

/** Props for {@link CodeAgentCard}. */
export interface CodeAgentCardProps {
  agent: CodeAgentItem;
  /** All-workspaces mode only: the owning workspace's display name (chip) - omitted in workspace mode. */
  workspaceName?: string;
}

/**
 * The card: hashed tile, name link to the read-only code canvas, an "In
 * code" chip, the directory path and config file, an optional workspace
 * chip, and a footer saying the agent is read-only. Defined in code, so
 * there is nothing here to toggle.
 */
export function CodeAgentCard({ agent, workspaceName }: CodeAgentCardProps): JSX.Element {
  const nameId = `code-card-name-${encodeURIComponent(agent.workspaceId)}/${encodeURIComponent(agent.id)}`;

  return (
    <li className="agent-card-item">
      <article className="agent-card tile-card agent-tile-host agent-card--code" aria-labelledby={nameId}>
        <div className="agent-card-body">
          <div className="agent-card-head">
            <AgentTile id={agent.id} size="md" />
            <div className="agent-card-heading">
              <h3 className="agent-card-name" id={nameId}>
                <a
                  className="agent-card-link"
                  href={`#${codeAgentPath(agent.workspaceId, agent.id)}`}
                  aria-label={`${agent.name}, defined in code`}
                >
                  {agent.name}
                </a>
              </h3>
              <div className="agent-card-meta">
                <span className="agent-card-label">In code</span>
                <span className="agent-card-sep" aria-hidden="true">
                  ·
                </span>
                <code className="agent-card-code-path" title={agent.id}>
                  {agent.id}
                </code>
                <span className="agent-card-sep" aria-hidden="true">
                  ·
                </span>
                <span className="agent-card-label">{agent.configFile}</span>
                {workspaceName !== undefined && (
                  <>
                    <span className="agent-card-sep" aria-hidden="true">
                      ·
                    </span>
                    <span className="chip agent-card-workspace">
                      <Folder size={16} aria-hidden="true" />
                      {workspaceName}
                    </span>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
        <footer className="agent-card-foot">
          <span>Read-only. Edit the files to change it.</span>
        </footer>
      </article>
    </li>
  );
}
