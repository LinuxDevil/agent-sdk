/**
 * The version diff sheet (L02, PLAN §9 "Diff view" / §11 Sheets): opened
 * from a Versions tab item's Changes button, it fetches the server-computed
 * `SpecChange[]` against the previous version (or a picked one) and groups
 * them under the fixed `SECTION_ORDER` sections via {@link groupChanges}.
 * The first version has nothing to compare with, so it shows its snapshot
 * as YAML instead.
 */
import { useEffect, useState, type JSX } from 'react';
import { stringify } from 'yaml';

import { errorMessage } from '../../components/errorMessage';
import { runtimeClient } from '../../runtime/runtimeClient';
import { ChangeList } from '../../ui/ChangeList';
import { toChangeItem } from '../../ui/changeValue';
import { Select } from '../../ui/controls';
import { EmptyState } from '../../ui/EmptyState';
import { Sheet } from '../../ui/Sheet';
import { SkeletonRows } from '../../ui/Skeleton';
import type { SpecChange, VersionListItem, VersionRecord } from '../../../shared/wireTypes';
import { groupChanges } from './versionLabels';
import './versionDiff.css';

/** Props for {@link VersionDiffSheet}. */
export interface VersionDiffSheetProps {
  agentId: string;
  /** The version whose changes the sheet shows (`v{version} changes`). */
  version: number;
  /** The tab's version list, newest first - the "Compare with" options. */
  versions: VersionListItem[];
  open: boolean;
  onClose(): void;
}

/**
 * The sheet's fetch result, keyed by the `version`/`against` pair it
 * answers: a `changes` list for a real comparison or a `snapshot` record
 * for the first version's YAML view.
 */
type DiffState =
  | { for: string; status: 'loading' }
  | { for: string; status: 'error'; message: string }
  | { for: string; status: 'changes'; changes: SpecChange[] }
  | { for: string; status: 'snapshot'; record: VersionRecord };

/** Fetches the diff (or the first version's record) for `key`, dropping stale answers. */
function useDiff(agentId: string, version: number, against: number | undefined, open: boolean, reload: number) {
  const [state, setState] = useState<DiffState>({ for: '', status: 'loading' });
  const key = against === undefined ? `v${version}:first` : `v${version}:v${against}`;

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setState({ for: key, status: 'loading' });
    const fail = (error: unknown) => {
      if (!cancelled) setState({ for: key, status: 'error', message: errorMessage(error) });
    };
    if (against === undefined) {
      runtimeClient.getVersion(agentId, version).then(
        (record) => !cancelled && setState({ for: key, status: 'snapshot', record }),
        fail,
      );
    } else {
      runtimeClient.diffVersion(agentId, version, against).then(
        (changes) => !cancelled && setState({ for: key, status: 'changes', changes }),
        fail,
      );
    }
    return () => {
      cancelled = true;
    };
  }, [open, agentId, version, against, key, reload]);

  // A state answering a different version/against pair never leaks into the current view.
  return state.for === key ? state : ({ status: 'loading' } as const);
}

/** The "Compare with" select row; `earlier` is newest first so option[0] is the previous version. */
function CompareSelect({
  earlier,
  against,
  previous,
  onPick,
}: {
  earlier: VersionListItem[];
  against: number;
  previous: number;
  onPick(against: number): void;
}): JSX.Element {
  return (
    <div className="version-diff-compare">
      <label className="field">
        Compare with{' '}
        <Select
          value={String(against)}
          onChange={(event) => onPick(Number(event.target.value))}
          options={earlier.map((item) => ({
            value: String(item.version),
            label: item.version === previous ? `v${item.version} (previous)` : `v${item.version}`,
          }))}
        />
      </label>
    </div>
  );
}

/** The grouped sections: one heading per non-empty section, then the section's ChangeList. */
function DiffSections({ changes }: { changes: SpecChange[] }): JSX.Element {
  return (
    <>
      {groupChanges(changes).map(({ section, changes: rows }) => (
        <section key={section} className="version-diff-section" aria-labelledby={`vd-${section}`}>
          <h3 id={`vd-${section}`} className="version-diff-section-title">
            {section} <span className="version-diff-count tabular-nums">{rows.length}</span>
          </h3>
          <ChangeList changes={rows.map(toChangeItem)} />
        </section>
      ))}
    </>
  );
}

/** The sheet body for the loaded/error/loading/snapshot states. */
function DiffBody({ state, onRetry }: { state: DiffState | { status: 'loading' }; onRetry(): void }): JSX.Element {
  if (state.status === 'loading') {
    return <SkeletonRows rows={4} />;
  }
  if (state.status === 'error') {
    return (
      <EmptyState
        title="Couldn't load the changes"
        hint={state.message}
        action={
          <button type="button" className="btn btn-sm" onClick={onRetry}>
            Retry
          </button>
        }
      />
    );
  }
  if (state.status === 'snapshot') {
    return (
      <>
        <p className="version-diff-first">This is the first version, so there is nothing to compare it with.</p>
        <pre className="version-diff-yaml">{stringify(state.record.snapshot.spec)}</pre>
      </>
    );
  }
  if (state.changes.length === 0) {
    return (
      <EmptyState
        icon={null}
        title="No differences recorded for this version."
        hint="It has the same configuration as the version it is compared with."
      />
    );
  }
  return <DiffSections changes={state.changes} />;
}

/**
 * Right-side sheet showing what one version changed. `against` defaults to
 * the highest version below `version` present in `versions`; the "Compare
 * with" select re-fetches on change. Closing (Escape, the close button,
 * the scrim) and focus return are the Sheet's useModal behaviour.
 */
export function VersionDiffSheet({ agentId, version, versions, open, onClose }: VersionDiffSheetProps): JSX.Element {
  // Versions below `version`, newest first: the compare options plus the default base.
  const earlier = versions.filter((item) => item.version < version);
  const previous = earlier[0]?.version;

  // A picked "Compare with" is keyed to `version` so it resets for the next version's sheet.
  const [picked, setPicked] = useState<{ version: number; against: number } | undefined>(undefined);
  const against = picked?.version === version ? picked.against : previous;

  const [reload, setReload] = useState(0);
  const state = useDiff(agentId, version, against, open, reload);

  return (
    <Sheet
      open={open}
      onClose={onClose}
      size="xl"
      title={`v${version} changes`}
      description={against === undefined ? undefined : `Compared with v${against}`}
    >
      <div className="version-diff">
        {against !== undefined && (
          <CompareSelect
            earlier={earlier}
            against={against}
            previous={previous ?? against}
            onPick={(next) => setPicked({ version, against: next })}
          />
        )}
        <DiffBody state={state} onRetry={() => setReload((n) => n + 1)} />
      </div>
    </Sheet>
  );
}
