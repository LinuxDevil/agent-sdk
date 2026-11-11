import { useCallback, useState, type JSX } from 'react';
import { Flag, Pencil, PlusCircle, Rocket, RotateCcw, type LucideIcon } from 'lucide-react';

import { errorMessage } from '../../components/errorMessage';
import { relativeTime } from '../../components/formatTime';
import { runtimeClient } from '../../runtime/runtimeClient';
import { useToast } from '../../ui/Toast';
import { EmptyState } from '../../ui/EmptyState';
import { SkeletonRows } from '../../ui/Skeleton';
import type { VersionKind, VersionListItem } from '../../../shared/wireTypes';
import { useAgentDetail } from './AgentDetailContext';
import { VersionDiffSheet } from './VersionDiffSheet';
import { fieldLabel, kindLabel, SOURCE_LABELS, summaryPending } from './versionLabels';
import { useVersions } from './useVersions';
import './versions.css';

/** The timeline dot's icon per version kind (14px, lucide). */
const KIND_ICONS: Record<VersionKind, LucideIcon> = {
  create: PlusCircle,
  update: Pencil,
  restore: RotateCcw,
  baseline: Flag,
  publish: Rocket,
};

/** Field chips shown before the `+N` overflow chip. */
const MAX_FIELD_CHIPS = 4;

/**
 * One timeline row (L01): number, kind/source, the "Current" pill on the
 * newest item, relative time, the summary (skeleton while the summary
 * pass is still writing it, the baseline hint for external edits), the
 * quoted request text and the changed-field chips. `version-actions`
 * holds the Changes button (L02; hidden on a baseline v1, which has no
 * diff to show) - L03/L14b add Restore/Publish buttons there.
 */
function VersionItem({
  item,
  isCurrent,
  onShowChanges,
}: {
  item: VersionListItem;
  isCurrent: boolean;
  onShowChanges(version: number): void;
}): JSX.Element {
  const Icon = KIND_ICONS[item.kind];
  const pending = summaryPending(item);
  const shown = item.changedFields.slice(0, MAX_FIELD_CHIPS);
  const hidden = item.changedFields.length - shown.length;
  return (
    <li className="version-item" data-version={item.version} data-kind={item.kind} data-current={isCurrent ? 'true' : undefined}>
      <span className="version-dot" aria-hidden="true">
        <Icon size={14} strokeWidth={1.75} aria-hidden="true" />
      </span>
      <div className="version-body">
        <div className="version-head">
          <span className="version-number">v{item.version}</span>
          <span className="version-kind">{kindLabel(item)}</span>
          <span className="version-source">{SOURCE_LABELS[item.source]}</span>
          {isCurrent && (
            <span className="status-pill pill-info">
              <span className="dot" aria-hidden="true" />
              Current
            </span>
          )}
          <time className="version-time" dateTime={item.createdAt} title={new Date(item.createdAt).toLocaleString()}>
            {relativeTime(item.createdAt)}
          </time>
        </div>
        {item.kind === 'baseline' ? (
          <p className="version-summary version-baseline">Recorded before the file was edited outside Studio.</p>
        ) : pending ? (
          <>
            <span className="skeleton version-summary-skeleton" aria-hidden="true" />
            <span className="visually-hidden">Writing a summary</span>
          </>
        ) : item.summary !== null ? (
          <p className="version-summary">{item.summary}</p>
        ) : null}
        {item.requestText !== null && <blockquote className="version-request">“{item.requestText}”</blockquote>}
        {item.changedFields.length > 0 && (
          <ul className="version-fields" aria-label="Changed fields">
            {shown.map((field) => (
              <li key={field} className="chip">
                {fieldLabel(field)}
              </li>
            ))}
            {hidden > 0 && <li className="chip">+{hidden}</li>}
          </ul>
        )}
        <div className="version-actions">
          {!(item.kind === 'baseline' && item.version === 1) && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => onShowChanges(item.version)}
            >
              Changes
            </button>
          )}
        </div>
      </div>
    </li>
  );
}

/**
 * The tab body once the header is drawn: the load error with Retry, the
 * first-fetch skeleton, the "No versions yet" empty state with its Save
 * action, or the timeline itself.
 */
function VersionList({
  items,
  error,
  saving,
  onSave,
  onRetry,
  onShowChanges,
}: {
  items: VersionListItem[] | undefined;
  error: string | undefined;
  saving: boolean;
  onSave(): void;
  onRetry(): void;
  onShowChanges(version: number): void;
}): JSX.Element {
  if (error !== undefined) {
    return (
      <EmptyState
        title="Couldn't load versions"
        hint={error}
        action={
          <button type="button" className="btn" onClick={onRetry}>
            Retry
          </button>
        }
      />
    );
  }
  if (items === undefined) {
    return <SkeletonRows rows={5} />;
  }
  if (items.length === 0) {
    return (
      <EmptyState
        title="No versions yet"
        hint="Save a version to start the history."
        action={
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={onSave}
            disabled={saving}
            aria-busy={saving || undefined}
          >
            Save version
          </button>
        }
      />
    );
  }
  return (
    <ol className="version-timeline">
      {items.map((item, index) => (
        <VersionItem
          key={item.version}
          item={item}
          isCurrent={index === 0}
          onShowChanges={onShowChanges}
        />
      ))}
    </ol>
  );
}

/**
 * The Versions tab (L01, PLAN §11 `/agents/:id/versions`): every saved
 * version newest-first on a timeline rail, refreshed live by `useVersions`
 * (`version.summary` events fill skeletons, `agent.changed` re-fetches),
 * plus the explicit "Save version" button. Reads the agent id from the
 * detail context like the other tab bodies. One shared `VersionDiffSheet`
 * (L02) opens for whichever item's Changes button was clicked.
 */
export function VersionsTab(): JSX.Element {
  const { record } = useAgentDetail();
  const { items, error, refresh } = useVersions(record.id);
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  // The version whose diff sheet is open; null keeps the one shared sheet closed.
  const [diffFor, setDiffFor] = useState<number | null>(null);

  const saveVersion = useCallback(async () => {
    setSaving(true);
    try {
      const { item, created } = await runtimeClient.saveVersion(record.id);
      toast.show({
        message: created ? `Saved v${item.version}` : `Nothing changed since v${item.version}`,
        tone: created ? 'success' : 'info',
      });
      await refresh();
    } catch (err) {
      toast.show({ message: errorMessage(err), tone: 'error' });
    } finally {
      setSaving(false);
    }
  }, [record.id, refresh, toast]);

  return (
    <section className="versions" aria-labelledby="versions-title">
      <header className="versions-header">
        <div>
          <h2 id="versions-title" className="versions-title">
            Versions
          </h2>
          <p className="versions-hint">Every save, restore and import is kept here. Restoring writes a new version.</p>
        </div>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => void saveVersion()}
          disabled={saving}
          aria-busy={saving || undefined}
        >
          Save version
        </button>
      </header>
      <VersionList
        items={items}
        error={error}
        saving={saving}
        onSave={() => void saveVersion()}
        onRetry={() => void refresh()}
        onShowChanges={setDiffFor}
      />
      <VersionDiffSheet
        agentId={record.id}
        version={diffFor ?? 0}
        versions={items ?? []}
        open={diffFor !== null}
        onClose={() => setDiffFor(null)}
      />
    </section>
  );
}
