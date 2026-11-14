/**
 * One observed agent as a card in the agents list (W07b): the A03 card's
 * look minus everything mutable - no switch, no menu. The whole card opens
 * `#/observed/<id>` through the name link's overlay; the link's aria-label
 * says "observed agent" so screen readers don't mistake it for an
 * editable Studio agent. `workspaceName` renders the workspace chip in
 * all-workspaces mode only.
 */
import { Folder } from 'lucide-react';

import type { ObservedAgentItem, ObservedStatus } from '../../../shared/wireTypes';
import { fmtAge } from '../../observe/format';
import { AgentTile } from '../../ui/AgentTile';
import { statusTone } from '../../ui/StatusPill';
import { observedAgentPath } from '../observed/observedRoute';
import '../../ui/tileCard.css';
import './agentCard.css';
import './observedAgentCard.css';

/** Props for {@link ObservedAgentCard}. */
export interface ObservedAgentCardProps {
  agent: ObservedAgentItem;
  /** All-workspaces mode only: the owning workspace's display name (chip) - omitted for Elsewhere and in workspace mode. */
  workspaceName?: string;
  /** `Date.now()` by default; tests pass a fixed value for stable ages. */
  now?: number;
}

/** The status pill's label - capitalised, unlike the daemon's raw words. */
const STATUS_LABEL: Record<ObservedStatus, string> = {
  healthy: 'Healthy',
  stale: 'Stale',
  down: 'Down',
  stopped: 'Stopped',
};

/**
 * The card: hashed tile, name link to the observed page, an "Observed"
 * chip and the rolled-up status pill, project/workspace/instance meta, and
 * a footer with last-seen and today's run count. Read-only by design.
 */
export function ObservedAgentCard({ agent, workspaceName, now = Date.now() }: ObservedAgentCardProps): JSX.Element {
  const nameId = `observed-card-name-${encodeURIComponent(agent.id)}`;
  const seenAt = Date.parse(agent.lastSeenAt);
  const seen = Number.isNaN(seenAt) ? null : { dateTime: agent.lastSeenAt, title: new Date(seenAt).toLocaleString(), text: fmtAge(now - seenAt) };

  return (
    <li className="agent-card-item">
      <article className="agent-card tile-card agent-tile-host agent-card--observed" aria-labelledby={nameId}>
        <div className="agent-card-body">
          <div className="agent-card-head">
            <AgentTile id={agent.id} size="md" />
            <div className="agent-card-heading">
              <h3 className="agent-card-name" id={nameId}>
                <a
                  className="agent-card-link"
                  href={`#${observedAgentPath(agent.id)}`}
                  aria-label={`${agent.name}, observed agent`}
                >
                  {agent.name}
                </a>
              </h3>
              <div className="agent-card-meta">
                <span className={`status-pill pill-${statusTone(agent.status)}`}>
                  <span className="dot" aria-hidden="true" />
                  {STATUS_LABEL[agent.status]}
                </span>
                <span className="agent-card-label">Observed</span>
                <span className="agent-card-sep" aria-hidden="true">
                  ·
                </span>
                <span className="agent-card-label agent-card-project" title={agent.project ?? undefined}>
                  {agent.project ?? 'No project'}
                </span>
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
                <span className="agent-card-sep" aria-hidden="true">
                  ·
                </span>
                <span>
                  {agent.instances} {agent.instances === 1 ? 'instance' : 'instances'}
                </span>
              </div>
            </div>
          </div>
        </div>
        <footer className="agent-card-foot">
          {seen !== null && (
            <span>
              Last seen{' '}
              <time dateTime={seen.dateTime} title={seen.title}>
                {seen.text}
              </time>
            </span>
          )}
          <span className="agent-card-updated">
            {agent.runsToday} {agent.runsToday === 1 ? 'run' : 'runs'} today
          </span>
        </footer>
      </article>
    </li>
  );
}
