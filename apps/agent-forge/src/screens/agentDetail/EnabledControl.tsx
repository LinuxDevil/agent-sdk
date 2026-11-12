/**
 * The detail header's enabled pill (A09): a StatusDot + Enabled/Disabled text
 * around a real `Switch`, PATCHing `meta.enabled` through
 * `PATCH /agents/:id/meta` with an optimistic `setRecord` and toast feedback.
 * Clicking anywhere on the pill toggles; keyboard users get the switch as the
 * one Tab stop, so the div stays role-less.
 */
import { useState } from 'react';
import { TriangleAlert } from 'lucide-react';

import type { AgentRecord } from '../../../shared/wireTypes';
import { runtimeClient } from '../../runtime/runtimeClient';
import { StatusDot } from '../../ui/StatusBadge';
import { Switch } from '../../ui/controls';
import { useToast } from '../../ui/Toast';
import { useAgentDetail } from './AgentDetailContext';

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Props for {@link EnabledControl}. */
export interface EnabledControlProps {
  record: AgentRecord;
}

/**
 * The "Enabled" pill in the header's actions row. Toggles optimistically;
 * on failure the previous meta is restored and the error toasted.
 */
export function EnabledControl({ record }: EnabledControlProps): JSX.Element {
  const { setRecord } = useAgentDetail();
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const { meta } = record;
  const enabled = meta.enabled;
  // L12: the wrapper's tooltip explains WHY the agent is off - an
  // auto-disable after failed triggered runs reads differently from a
  // manual switch-off.
  const title = enabled
    ? 'On. Triggers can start it.'
    : meta.disabledReason === 'auto_failure_streak'
      ? 'Turned off automatically after 5 failed triggered runs. Turn it on to try again.'
      : "Turned off. Triggers won't start it.";

  const apply = async (next: boolean) => {
    if (pending) return;
    const previous = meta;
    setPending(true);
    setRecord({ ...record, meta: { ...meta, enabled: next } });
    try {
      const saved = await runtimeClient.patchAgentMeta(record.id, { enabled: next });
      setRecord({ ...record, meta: saved });
      toast.show({ message: `“${record.spec.name}” is ${next ? 'on' : 'off'}`, tone: 'success' });
    } catch (error) {
      setRecord({ ...record, meta: previous });
      toast.show({ message: messageOf(error), tone: 'error' });
    } finally {
      setPending(false);
    }
  };

  return (
    <div
      className={['enabled-control', enabled ? 'is-on' : undefined].filter(Boolean).join(' ')}
      data-pending={pending ? '' : undefined}
      title={title}
      onClick={(event) => {
        // The switch handles its own click; everything else on the pill toggles.
        if ((event.target as HTMLElement).closest('.switch-wrap') !== null) return;
        void apply(!enabled);
      }}
    >
      <StatusDot status={enabled ? 'enabled' : 'disabled'} halo={enabled} />
      <span className="enabled-control-text" aria-hidden="true">
        {enabled ? 'Enabled' : 'Disabled'}
      </span>
      <Switch
        size="sm"
        checked={enabled}
        label="Agent enabled"
        disabled={pending}
        onChange={(next) => void apply(next)}
      />
      {!enabled && meta.disabledReason === 'auto_failure_streak' && (
        <span className="status-pill pill-warning">Auto-off</span>
      )}
    </div>
  );
}

/** Props for {@link AutoDisableNotice}. */
export interface AutoDisableNoticeProps {
  record: AgentRecord;
}

/**
 * The warning under the facts row when the agent was switched off after a
 * failure streak (`disabledReason: 'auto_failure_streak'`); renders nothing
 * otherwise.
 */
export function AutoDisableNotice({ record }: AutoDisableNoticeProps): JSX.Element | null {
  const { meta } = record;
  if (meta.enabled || meta.disabledReason !== 'auto_failure_streak') return null;
  const when = meta.disabledAt !== null ? ` on ${new Date(meta.disabledAt).toLocaleString()}` : '';
  return (
    <div className="agent-detail-notice" role="status">
      <TriangleAlert size={14} strokeWidth={1.75} aria-hidden="true" />
      <p>{`Turned off after 5 failed runs in a row${when}. Fix the cause, then turn it back on.`}</p>
    </div>
  );
}
