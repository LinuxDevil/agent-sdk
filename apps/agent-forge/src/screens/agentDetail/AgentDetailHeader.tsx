import { useState, type ReactNode } from 'react';
import { CircleAlert, CircleCheck, CircleDashed, Clock, Cpu, Play, Wrench, Zap, type LucideIcon } from 'lucide-react';

import type { AgentRecord, Requirement } from '../../../shared/wireTypes';
import { fmtAge } from '../../observe/format';
import { agentTabPath, AGENT_TAB_LABELS, AGENT_TABS, BUILT_AGENT_TABS, type AgentTab } from '../agents/agentTabs';
import { AgentTile } from '../../ui/AgentTile';
import { StatusBadge } from '../../ui/StatusBadge';
import { Tabs } from '../../ui/Tabs';
import './agentDetail.css';

/** One facts-row entry: a decorative icon, its accessible label and the shown value. */
export interface HeaderFact {
  icon: LucideIcon;
  label: string;
  value: string;
}

/**
 * The facts row under the title, in order: model, tool count, trigger count
 * and last edit age. `now` is `Date.now()` in the screen; tests pass a fixed
 * value so the "Updated … ago" text is stable.
 */
export function headerFacts(record: AgentRecord, now: number): HeaderFact[] {
  const { spec } = record;
  const tools = spec.tools?.length ?? 0;
  const triggers = spec.triggers?.length ?? 0;
  return [
    { icon: Cpu, label: 'Model', value: spec.model },
    { icon: Wrench, label: 'Tools', value: tools === 0 ? 'No tools' : `${tools} ${tools === 1 ? 'tool' : 'tools'}` },
    { icon: Zap, label: 'Triggers', value: triggers === 0 ? 'No triggers' : `${triggers} ${triggers === 1 ? 'trigger' : 'triggers'}` },
    { icon: Clock, label: 'Updated', value: `Updated ${fmtAge(now - Date.parse(record.updatedAt))}` },
  ];
}

/** The readiness chip's icon for a requirement status. */
const CHIP_ICONS: Record<Requirement['status'], LucideIcon> = {
  ok: CircleCheck,
  missing: CircleAlert,
  unknown: CircleDashed,
};

/** Where a chip's `fix` sends the user; `probe` needs the agent's canvas, the rest the Settings screen. */
function fixHref(fix: NonNullable<Requirement['fix']>, agentId: string): string {
  if (fix.action === 'probe') return `#${agentTabPath(agentId, 'canvas')}`;
  return '#/settings';
}

/**
 * The readiness chips pinned at the right of the tab strip: every `missing`
 * or `unknown` requirement as a chip (a link when it has a `fix`), or a
 * single "Ready to run" chip when every row is `ok`. Renders nothing when the
 * record carries no `requirements` (AA13 predates it) or the list is empty.
 */
// fallow-ignore-next-line unused-export -- contract surface: the header renders it internally; later tickets/tests import it directly
export function ReadinessChips({ requirements, agentId }: { requirements: Requirement[] | undefined; agentId: string }): JSX.Element | null {
  if (requirements === undefined || requirements.length === 0) return null;
  const attention = requirements.filter((r) => r.status !== 'ok');
  const rows = attention.length > 0 ? attention : requirements.filter((r) => r.status === 'ok').slice(0, 1);
  const ready = attention.length === 0;
  return (
    <ul className="readiness-chips" aria-label="Readiness">
      {rows.map((r) => {
        const Icon = ready ? CHIP_ICONS.ok : CHIP_ICONS[r.status];
        const status = ready ? 'ok' : r.status;
        const label = ready ? 'Ready to run' : r.label;
        const className = `readiness-chip readiness-${status}`;
        const icon = <Icon size={12} strokeWidth={1.75} aria-hidden="true" />;
        if (!ready && r.fix !== undefined) {
          return (
            <li key={r.id}>
              <a className={className} href={fixHref(r.fix, agentId)}>
                {icon}
                {label}
              </a>
            </li>
          );
        }
        return (
          <li key={r.id}>
            <span className={className}>
              {icon}
              {label}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** Props for {@link AgentDetailHeader}. */
export interface AgentDetailHeaderProps {
  record: AgentRecord;
  /** The tab the route names - the tab strip marks it current. */
  tab: AgentTab;
  /** The overflow menu (A12 passes its `Menu`); nothing renders until then. */
  menu?: ReactNode;
  /** The enabled-state control (A09 passes its switch); a status badge by default. */
  enabledControl?: ReactNode;
  /** The labels fact (A09's `HeaderLabels`), rendered as the facts row's last item. */
  labelsItem?: ReactNode;
  /** Notices under the facts row (A09's auto-disable notice). */
  notices?: ReactNode;
}

/**
 * The agent detail screen's header (PLAN §11): breadcrumb, tile, name with
 * its published/draft badge, a clamped description with Show more, the
 * actions row (enabled state, Test, overflow menu), the facts row and the
 * tab strip with the readiness chips pinned right.
 */
export function AgentDetailHeader({ record, tab, menu, enabledControl, labelsItem, notices }: AgentDetailHeaderProps): JSX.Element {
  const { id, spec, meta } = record;
  const [expanded, setExpanded] = useState(false);
  const description = spec.description ?? '';
  const canExpand = description.length > 140 || description.includes('\n');
  const name = spec.name;
  const facts = headerFacts(record, Date.now());

  return (
    <header className="agent-detail-header">
      <nav className="page-header-crumbs" aria-label="Breadcrumb">
        <ol>
          <li>
            <a href="#/agents">Agents</a>
          </li>
          <li aria-hidden="true">
            <span className="page-header-crumb-sep">›</span>
          </li>
          <li>
            <span aria-current="page">{name}</span>
          </li>
        </ol>
      </nav>
      <div className="agent-detail-top">
        <AgentTile id={id} size="lg" muted={!meta.enabled} />
        <div className="agent-detail-heading">
          <div className="agent-detail-title-row">
            <h1 className="agent-detail-name" title={name}>
              {name}
            </h1>
            {meta.publishedVersion != null ? (
              <StatusBadge status="published" label={`Published v${meta.publishedVersion}`} size="sm" />
            ) : (
              <StatusBadge status="draft" label="Not published" size="sm" />
            )}
          </div>
          {description !== '' && (
            <>
              <p className={['agent-detail-description', expanded ? 'is-expanded' : undefined].filter(Boolean).join(' ')}>{description}</p>
              {canExpand && (
                <button type="button" className="agent-detail-more" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
                  {expanded ? 'Show less' : 'Show more'}
                </button>
              )}
            </>
          )}
        </div>
        <div className="agent-detail-actions">
          {enabledControl ?? <StatusBadge status={meta.enabled ? 'enabled' : 'disabled'} />}
          <a className="btn btn-primary btn-sm" href={`#${agentTabPath(id, 'canvas')}?test=1`}>
            <Play size={14} strokeWidth={1.75} aria-hidden="true" />
            Test
          </a>
          {menu}
        </div>
      </div>
      <ul className="agent-detail-facts" aria-label="Facts">
        {facts.map((fact) => (
          <li key={fact.label} className="agent-detail-fact" title={fact.label}>
            <fact.icon size={14} strokeWidth={1.75} aria-hidden="true" />
            <span className="visually-hidden">{`${fact.label}: `}</span>
            <span>{fact.value}</span>
          </li>
        ))}
        {labelsItem}
      </ul>
      {notices}
      <div className="agent-detail-tabs">
        <Tabs
          label="Agent"
          currentId={tab}
          items={AGENT_TABS.map((t) => ({
            id: t,
            label: AGENT_TAB_LABELS[t],
            href: `#${agentTabPath(id, t)}`,
            disabled: !BUILT_AGENT_TABS.has(t),
            disabledReason: 'Coming in a later release',
          }))}
          trailing={<ReadinessChips requirements={record.requirements} agentId={id} />}
        />
      </div>
    </header>
  );
}
