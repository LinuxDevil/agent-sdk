import { Bot, Server, Wrench, type LucideIcon } from 'lucide-react';

import type { AgentListItem } from '../../../shared/wireTypes';
import { fmtAge } from '../../observe/format';
import { AgentTile } from '../../ui/AgentTile';
import { StatusBadge, StatusDot } from '../../ui/StatusBadge';
import { statusKey } from '../../ui/status';
import { Switch } from '../../ui/controls';
import { agentTabPath } from '../agents/agentTabs';
import './agentCard.css';

/**
 * Optional capability counts for the card's chips. `AgentListItem.counts`
 * (D06a) already carries these plus `triggers`; this narrower shape is what
 * the card renders, so chips appear only for the counts it knows about.
 */
export interface AgentCapabilityCounts {
  tools: number;
  mcpServers: number;
  subagents: number;
}

/**
 * The agent row the card renders. `counts` is optional so the card still
 * works against list payloads that predate D06a's `counts` field (no chips
 * then) - and so tests can exercise the chip-less state.
 */
export type AgentCardAgent = Omit<AgentListItem, 'counts'> & { counts?: AgentCapabilityCounts };

/** Props for {@link AgentCard}. */
export interface AgentCardProps {
  agent: AgentCardAgent;
  /** Called with the agent id when the card (not the switch) is activated. */
  onOpen(id: string): void;
  /** Called with the agent id and the switch's new state. */
  onToggleEnabled(id: string, enabled: boolean): void;
  /** Disables the switch while a PATCH is in flight. */
  toggling?: boolean;
  /** `Date.now()` by default; tests pass a fixed value for stable ages. */
  now?: number;
}

const MAX_LABELS = 4;

/** Footer copy for a last run's raw status, folded through {@link statusKey}. */
export function lastRunLabel(status: string): string {
  switch (statusKey(status)) {
    case 'done':
      return 'Last run succeeded';
    case 'error':
      return 'Last run failed';
    case 'running':
      return 'Running now';
    case 'waiting':
      return 'Waiting on you';
    case 'stopped':
      return 'Last run stopped';
    case 'timed_out':
      return 'Last run timed out';
    default:
      return 'Last run';
  }
}

interface CapChip {
  key: 'tools' | 'mcpServers' | 'subagents';
  icon: LucideIcon;
  text: string;
  violet?: boolean;
}

/** The non-zero capability chips, in DOM order; empty when `counts` is absent. */
function capabilityChips(counts: AgentCapabilityCounts | undefined): CapChip[] {
  if (!counts) return [];
  const chips: CapChip[] = [
    { key: 'tools', icon: Wrench, text: `${counts.tools} ${counts.tools === 1 ? 'tool' : 'tools'}` },
    { key: 'mcpServers', icon: Server, text: `${counts.mcpServers} ${counts.mcpServers === 1 ? 'MCP server' : 'MCP servers'}` },
    { key: 'subagents', icon: Bot, text: `${counts.subagents} ${counts.subagents === 1 ? 'subagent' : 'subagents'}`, violet: true },
  ];
  return chips.filter((chip) => {
    const n = counts[chip.key];
    return n > 0;
  });
}

interface TimeText {
  dateTime: string;
  title: string;
  text: string;
}

/** A `<time>`'s attributes and age text; `null` when the ISO string does not parse. */
function timeText(iso: string, now: number): TimeText | null {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return null;
  return { dateTime: iso, title: new Date(at).toLocaleString(), text: fmtAge(now - at) };
}

/**
 * One agent as a card in the agents list (PLAN §11): hashed tile, name link
 * (the whole card is clickable via the link's `::after` overlay), model and
 * published-version meta, an On/Off switch that never opens the agent, a
 * clamped description, labels and capability chips, and a footer with the
 * last run's status and both timestamps. A disabled agent keeps full text
 * contrast - only the tile goes grey - so the card stays AA-readable.
 */
export function AgentCard({ agent, onOpen, onToggleEnabled, toggling = false, now = Date.now() }: AgentCardProps): JSX.Element {
  const { id, name, description, model, enabled, labels, updatedAt, publishedVersion, lastRun } = agent;
  const nameId = `agent-card-name-${encodeURIComponent(id)}`;
  const caps = capabilityChips(agent.counts);
  const lastRunTime = lastRun ? timeText(lastRun.at, now) : null;
  const updatedTime = timeText(updatedAt, now);
  const hiddenLabels = labels.slice(MAX_LABELS);

  return (
    <li className="agent-card-item">
      <article
        className={['agent-card', 'agent-tile-host', enabled ? undefined : 'agent-card-off'].filter(Boolean).join(' ')}
        aria-labelledby={nameId}
      >
        <div className="agent-card-body">
          <div className="agent-card-head">
            <AgentTile id={id} size="md" muted={!enabled} />
            <div className="agent-card-heading">
              <h3 className="agent-card-name" id={nameId}>
                <a
                  className="agent-card-link"
                  href={`#${agentTabPath(id, 'overview')}`}
                  onClick={(event) => {
                    event.preventDefault();
                    onOpen(id);
                  }}
                >
                  {name}
                </a>
              </h3>
              <div className="agent-card-meta">
                <span className="agent-card-model" title={model}>
                  {model}
                </span>
                {publishedVersion != null && (
                  <>
                    <span className="agent-card-sep" aria-hidden="true">
                      ·
                    </span>
                    <StatusBadge status="published" label={`v${publishedVersion}`} size="sm" icon={false} title="Published version" />
                  </>
                )}
              </div>
            </div>
            <div className="agent-card-toggle">
              <span className="agent-card-state overline" aria-hidden="true">
                {enabled ? 'On' : 'Off'}
              </span>
              <Switch
                size="sm"
                checked={enabled}
                label={`${name} enabled`}
                disabled={toggling}
                onChange={(value) => onToggleEnabled(id, value)}
              />
            </div>
          </div>
          {description !== '' && (
            <p className="agent-card-description" title={description}>
              {description}
            </p>
          )}
          {labels.length > 0 && (
            <ul className="agent-card-labels" aria-label="Labels">
              {labels.slice(0, MAX_LABELS).map((label) => (
                <li key={label} className="agent-card-label">
                  {label}
                </li>
              ))}
              {hiddenLabels.length > 0 && (
                <li className="agent-card-label-more" title={hiddenLabels.join(', ')}>
                  +{hiddenLabels.length}
                </li>
              )}
            </ul>
          )}
          {caps.length > 0 && (
            <ul className="agent-card-caps" aria-label="Capabilities">
              {caps.map((chip) => (
                <li key={chip.key} className={['agent-card-cap', chip.violet ? 'agent-card-cap-violet' : undefined].filter(Boolean).join(' ')}>
                  <chip.icon size={12} strokeWidth={1.75} aria-hidden="true" />
                  {chip.text}
                </li>
              ))}
            </ul>
          )}
        </div>
        <footer className="agent-card-foot">
          {lastRun ? (
            <>
              <StatusDot status={statusKey(lastRun.status)} />
              <span>{lastRunLabel(lastRun.status)}</span>
              {lastRunTime && (
                <>
                  <span className="agent-card-sep" aria-hidden="true">
                    ·
                  </span>
                  <time dateTime={lastRunTime.dateTime} title={lastRunTime.title}>
                    {lastRunTime.text}
                  </time>
                </>
              )}
            </>
          ) : (
            <span className="agent-card-never">Never run</span>
          )}
          {updatedTime && (
            <span className="agent-card-updated">
              Updated{' '}
              <time dateTime={updatedTime.dateTime} title={updatedTime.title}>
                {updatedTime.text}
              </time>
            </span>
          )}
        </footer>
      </article>
    </li>
  );
}
