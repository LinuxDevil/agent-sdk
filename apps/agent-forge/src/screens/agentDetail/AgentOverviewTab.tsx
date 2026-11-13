import { ChevronRight, TriangleAlert } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import type { AgentSpecV2 } from '@linuxdevil/lousho/spec';

import type { ChannelTriggerStatus, TraceSummaryPayload } from '../../../shared/wireTypes';
import { agentTabPath, BUILT_AGENT_TABS } from '../agents/agentTabs';
import { fmtAge, fmtDateTime, fmtDuration } from '../../observe/format';
import { Card } from '../../ui/Card';
import { SkeletonRows } from '../../ui/Skeleton';
import { StatusDot } from '../../ui/StatusBadge';
import { statusKey } from '../../ui/status';
import { useAgentDetail } from './AgentDetailContext';
import { runtimeClient } from '../../runtime/runtimeClient';
import {
  capabilityRows,
  missingRequirements,
  permissionRuleText,
  safetySummary,
  triggerLine,
  type CapabilityRow,
  type SafetySummary,
} from './overviewModel';
import { useRecentRuns } from './useRecentRuns';
import './agentOverview.css';

/** Lines of the instructions string the Overview card shows before the "N more lines" note. */
const INSTRUCTIONS_LINES = 12;

/** One `spec.triggers` entry, narrowed off the spec. */
type TriggerSpec = NonNullable<AgentSpecV2['triggers']>[number];
type WebhookTrigger = Extract<TriggerSpec, { type: 'webhook' }>;
type ChannelTrigger = Extract<TriggerSpec, { type: 'channel' }>;

/** The public URL a channel trigger listens on: `/hooks/<agentId>/channel/<kind>` (R08b). */
function channelUrl(agentId: string, trigger: ChannelTrigger): string {
  return `${window.location.origin}/hooks/${agentId}/channel/${trigger.channel}`;
}

/** A channel trigger's webhook-settings URL with Copy, plus its mount error when the host could not serve it. */
function ChannelUrl({
  agentId,
  trigger,
  status,
}: {
  agentId: string;
  trigger: ChannelTrigger;
  status: ChannelTriggerStatus | undefined;
}): JSX.Element {
  const url = channelUrl(agentId, trigger);
  return (
    <span className="agent-overview-webhook">
      <code>{url}</code>
      <button
        type="button"
        className="btn btn-sm btn-ghost"
        onClick={() => void navigator.clipboard?.writeText(url)}
      >
        Copy
      </button>
      {status?.error !== null && status?.error !== undefined && (
        <span className="agent-overview-channel-error">{status.error}</span>
      )}
    </span>
  );
}

/** The agent's channel-trigger mount rows (`GET /agents/:id/triggers/status`), keyed by trigger id; empty until loaded. */
function useChannelStatuses(agentId: string): Map<string, ChannelTriggerStatus> {
  const [statuses, setStatuses] = useState<ChannelTriggerStatus[]>([]);
  useEffect(() => {
    let cancelled = false;
    runtimeClient
      .channelTriggerStatus(agentId)
      .then((rows) => {
        if (!cancelled) setStatuses(rows);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [agentId]);
  return new Map(statuses.map((row) => [row.triggerId, row]));
}

/** The public URL a webhook trigger listens on: `/hooks/<agentId>` + the trigger's own `path`. */
function webhookUrl(agentId: string, trigger: WebhookTrigger): string {
  return `${window.location.origin}/hooks/${agentId}${trigger.path}`;
}

/** A webhook trigger's URL with a Copy button (R08a); the URL is public - no token rides it. */
function WebhookUrl({ agentId, trigger }: { agentId: string; trigger: WebhookTrigger }): JSX.Element {
  const url = webhookUrl(agentId, trigger);
  return (
    <span className="agent-overview-webhook">
      <code>{url}</code>
      <button
        type="button"
        className="btn btn-sm btn-ghost"
        onClick={() => void navigator.clipboard?.writeText(url)}
      >
        Copy
      </button>
    </span>
  );
}

/** A chip list for a card row: `None` (the muted missing marker) when the spec has no items. */
function SpecChips({ items }: { items: string[] }): JSX.Element {
  if (items.length === 0) return <span className="value-missing">None</span>;
  return (
    <ul className="agent-overview-chips">
      {items.map((item, index) => (
        <li key={`${item}-${index}`} className="agent-overview-chip">
          {item}
        </li>
      ))}
    </ul>
  );
}

/** One `dl` row of a spec card: the muted term and its chips/text. */
function SpecRow({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="agent-overview-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** The "can't run yet" banner: the missing requirement labels plus the Settings link; renders nothing when all is ok. */
function MissingBanner({ missing }: { missing: ReturnType<typeof missingRequirements> }): JSX.Element | null {
  if (missing.length === 0) return null;
  const labels = missing.map((requirement) => requirement.label).join(', ');
  return (
    <div className="agent-overview-banner" role="status">
      <TriangleAlert size={16} strokeWidth={1.75} aria-hidden="true" />
      <p>{`This agent can’t run yet: ${labels}.`}</p>
      <a className="btn btn-sm" href="#/settings">
        Open settings
      </a>
    </div>
  );
}

/** The Capabilities card: the six fixed rows, each a label and its item chips (or 'None'). */
function CapabilitiesCard({ rows }: { rows: CapabilityRow[] }): JSX.Element {
  return (
    <Card title="Capabilities">
      <dl className="agent-overview-dl">
        {rows.map((row) => (
          <SpecRow key={row.key} label={row.label}>
            <SpecChips items={row.items} />
          </SpecRow>
        ))}
      </dl>
    </Card>
  );
}

/** The Triggers card: one icon + line per trigger (webhooks and channels also show their URL), or the empty copy. */
function TriggersCard({ agentId, triggers }: { agentId: string; triggers: TriggerSpec[] }): JSX.Element {
  const channelStatuses = useChannelStatuses(agentId);
  return (
    <Card title="Triggers">
      {triggers.length > 0 ? (
        <ul className="agent-overview-list">
          {triggers.map((trigger) => {
            const line = triggerLine(trigger);
            return (
              <li key={trigger.id}>
                <line.icon size={14} strokeWidth={1.75} aria-hidden="true" />
                <span>{line.text}</span>
                {trigger.type === 'webhook' && <WebhookUrl agentId={agentId} trigger={trigger} />}
                {trigger.type === 'channel' && (
                  <ChannelUrl agentId={agentId} trigger={trigger} status={channelStatuses.get(trigger.id)} />
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="agent-overview-empty">No triggers. Runs start from the Test pane or chat.</p>
      )}
      {triggers.some((trigger) => trigger.type === 'channel') && (
        <p className="agent-overview-empty">Channel runs show up in Runs and Traces.</p>
      )}
    </Card>
  );
}

/** The Safety card: guardrail chips, permission-rule counts, the mode and the limit chips. */
function SafetyCard({ safety }: { safety: SafetySummary }): JSX.Element {
  const ruleText = permissionRuleText(safety.rules);
  return (
    <Card title="Safety">
      <dl className="agent-overview-dl">
        <SpecRow label="Guardrails">
          <SpecChips items={safety.guardrails} />
        </SpecRow>
        <SpecRow label="Permission rules">
          {ruleText === '' ? <span className="value-missing">None</span> : <span>{ruleText}</span>}
        </SpecRow>
        <SpecRow label="Permission mode">
          <span>{safety.permissionMode ?? 'Default'}</span>
        </SpecRow>
        <SpecRow label="Limits">
          <SpecChips items={safety.limits} />
        </SpecRow>
      </dl>
    </Card>
  );
}

/** One Recent runs row: status dot, trace name, duration, age and the chevron; links to the trace viewer. */
function RunRow({ trace }: { trace: TraceSummaryPayload }): JSX.Element {
  return (
    <li>
      <a className="agent-overview-run" href={`#/traces/${encodeURIComponent(trace.traceId)}`}>
        <StatusDot status={statusKey(trace.status)} title={trace.status === 'ok' ? 'Succeeded' : 'Failed'} />
        <span className="agent-overview-run-name">{trace.name}</span>
        <span className="tabular-nums">{fmtDuration(trace.durationMs)}</span>
        <time dateTime={new Date(trace.startTime).toISOString()} title={fmtDateTime(trace.startTime)}>
          {fmtAge(Date.now() - trace.startTime)}
        </time>
        <ChevronRight size={14} strokeWidth={1.75} aria-hidden="true" />
      </a>
    </li>
  );
}

/** The Recent runs card body: skeleton while loading, retryable error, empty copy or the five newest runs. */
function RecentRunsBody({ agentId }: { agentId: string }): JSX.Element {
  const { runs, error, refresh } = useRecentRuns(agentId);
  if (error !== undefined) {
    return (
      <>
        <p className="agent-overview-empty">Could not load runs.</p>
        <button type="button" className="btn btn-sm" onClick={refresh}>
          Retry
        </button>
      </>
    );
  }
  if (runs === undefined) return <SkeletonRows rows={3} />;
  if (runs.length === 0) {
    return (
      <>
        <p className="agent-overview-empty">No runs yet. Try it from the Test pane.</p>
        <a className="btn btn-sm" href={`#${agentTabPath(agentId, 'canvas')}?test=1`}>
          Open Test pane
        </a>
      </>
    );
  }
  return (
    <ul className="agent-overview-runs">
      {runs.map((trace) => (
        <RunRow key={trace.traceId} trace={trace} />
      ))}
    </ul>
  );
}

/** The Recent runs card: the five newest local traces, with an 'All runs' link once that tab exists. */
function RecentRunsCard({ agentId }: { agentId: string }): JSX.Element {
  return (
    <Card
      title="Recent runs"
      actions={
        BUILT_AGENT_TABS.has('runs') ? (
          <a className="btn btn-sm btn-ghost" href={`#${agentTabPath(agentId, 'runs')}`}>
            All runs
          </a>
        ) : undefined
      }
    >
      <RecentRunsBody agentId={agentId} />
    </Card>
  );
}

/**
 * The Overview tab (A06): the "can't run yet" banner over the missing
 * requirements, then the Instructions card (A05) and the Capabilities,
 * Triggers, Safety and Recent runs cards in a two-column grid when the
 * container is wide enough (see agentOverview.css).
 */
export function AgentOverviewTab() {
  const { record } = useAgentDetail();
  const { spec } = record;
  const missing = missingRequirements(record.requirements);
  const instructions = spec.instructions;
  const editHref = `#${agentTabPath(record.id, 'canvas')}`;
  const lines = typeof instructions === 'string' ? instructions.split('\n') : [];
  const shown = lines.slice(0, INSTRUCTIONS_LINES);
  const hidden = lines.length - shown.length;

  return (
    <div className="agent-overview">
      <MissingBanner missing={missing} />
      <Card
        className="agent-overview-instructions-card"
        title="Instructions"
        actions={
          <a className="btn btn-sm btn-ghost" href={editHref}>
            Edit on canvas
          </a>
        }
      >
        {typeof instructions === 'string' ? (
          <>
            <pre className="agent-overview-instructions">{shown.join('\n')}</pre>
            {hidden > 0 && <p className="agent-overview-more">{`${hidden} more lines`}</p>}
          </>
        ) : (
          <p>
            Loaded from <code>{instructions.file}</code>
          </p>
        )}
      </Card>
      <CapabilitiesCard rows={capabilityRows(spec)} />
      <TriggersCard agentId={record.id} triggers={spec.triggers ?? []} />
      <SafetyCard safety={safetySummary(spec)} />
      <RecentRunsCard agentId={record.id} />
    </div>
  );
}
