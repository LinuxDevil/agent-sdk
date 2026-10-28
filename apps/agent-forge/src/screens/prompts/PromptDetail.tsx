/**
 * `#/prompts/:name[@ref]` - one prompt: the selected version (its text,
 * labels, "Move <label> here", runs and Playground links), a side-by-side
 * diff between any two versions (`?diff=a,b`), and the version history.
 *
 * Reads `GET /api/v1/prompts/:name` (every version, text included, newest
 * first); a label move is `PUT /api/v1/prompts/:name/labels/:label` through
 * the studio proxy's write allowlist, then a refetch. Selecting a version or
 * changing the diff replaces the history entry, so Back leaves the prompt.
 */
import { useState } from 'react';
import { navigate } from '../../router/router';
import { useRoute } from '../../router/useRoute';
import { usePromptVersions } from '../../observe/useObserve';
import { ObserveError } from '../../observe/chrome';
import { observeClient } from '../../observe/observeClient';
import type { ObservePromptVersion } from '../../observe/types';
import { fmtDateTime, fmtInt } from '../../observe/format';
import { DataTable, type Column } from '../../ui/DataTable';
import { EmptyState } from '../../ui/EmptyState';
import { useToast } from '../../ui/Toast';
import { LabelChips } from './LabelChips';
import { PromptDiff } from './PromptDiff';
import { parseDiff, parsePromptRoute, promptPath, promptPlaygroundHref, promptRunsHref, resolveRef } from './promptsUrl';

const BackLink = () => <a href="#/prompts">Back to prompts</a>;

/** `variables` is stored verbatim; an array of names is the common shape. */
const variablesText = (variables: unknown): string =>
  Array.isArray(variables) && variables.length > 0 ? variables.map(String).join(', ') : '-';

const COLUMNS: Column<ObservePromptVersion>[] = [
  { key: 'version', header: 'Version', width: 80, render: (v) => `v${v.version}` },
  { key: 'created', header: 'Created', width: 140, render: (v) => fmtDateTime(v.created_at) },
  { key: 'labels', header: 'Labels', width: 200, render: (v) => <LabelChips labels={v.labels} /> },
  { key: 'uses', header: 'Uses', align: 'right', width: 80, render: (v) => fmtInt(v.uses) },
  { key: 'variables', header: 'Variables', width: 180, hideBelow: 720, render: (v) => variablesText(v.variables) },
];

/** Every label of the prompt (across versions), sorted. */
const allLabels = (versions: readonly ObservePromptVersion[]): string[] => [...new Set(versions.flatMap((v) => v.labels))].sort();

/** "Move <label> here" for every label of this prompt not already on `selected`; a toast reports the outcome. */
function LabelMoves({
  name,
  selected,
  versions,
  onMoved,
}: {
  name: string;
  selected: ObservePromptVersion;
  versions: readonly ObservePromptVersion[];
  onMoved: () => void;
}) {
  const toast = useToast();
  const [pending, setPending] = useState<string | undefined>();
  const movable = allLabels(versions).filter((label) => !selected.labels.includes(label));
  if (movable.length === 0) return null;

  const move = async (label: string) => {
    setPending(label);
    try {
      const moved = await observeClient.movePromptLabel(name, label, selected.version);
      const was = moved.previous_version === null ? '' : ` (was version ${moved.previous_version})`;
      toast.show({ tone: 'success', message: `Moved ${label} to version ${moved.version}${was}.` });
      onMoved();
    } catch (error) {
      toast.show({ tone: 'error', message: `Could not move ${label}: ${(error as Error).message}` });
    } finally {
      setPending(undefined);
    }
  };

  return (
    <div className="prompt-moves">
      {movable.map((label) => (
        <button key={label} type="button" className="btn" disabled={pending !== undefined} onClick={() => void move(label)}>
          Move {label} here
        </button>
      ))}
    </div>
  );
}

/** The A/B pickers and, when `?diff=a,b` names two known versions, the diff itself. */
function Compare({
  name,
  refParam,
  selected,
  versions,
  diff,
}: {
  name: string;
  refParam: string | undefined;
  selected: ObservePromptVersion;
  versions: readonly ObservePromptVersion[];
  diff: [number, number] | undefined;
}) {
  const find = (n: number) => versions.find((v) => v.version === n);
  const a = diff && find(diff[0]);
  const b = diff && find(diff[1]);
  // Default pair: the version before the selected one, then the selected one.
  const previous = versions.find((v) => v.version < selected.version) ?? selected;
  const pickA = a?.version ?? previous.version;
  const pickB = b?.version ?? selected.version;
  const setDiff = (next: [number, number] | undefined) => navigate(promptPath(name, refParam, next), { replace: true });

  const picker = (label: string, value: number, onChange: (n: number) => void) => (
    <select aria-label={label} value={value} onChange={(e) => onChange(Number(e.target.value))}>
      {versions.map((v) => (
        <option key={v.version} value={v.version}>
          v{v.version}
          {v.labels.length > 0 ? ` (${v.labels.join(', ')})` : ''}
        </option>
      ))}
    </select>
  );

  return (
    <section className="prompt-compare" aria-label="Compare versions">
      <h3 className="prompt-section-title">Compare versions</h3>
      <div className="prompt-compare-bar">
        {picker('Compare version A', pickA, (n) => setDiff([n, pickB]))}
        <span aria-hidden="true">vs</span>
        {picker('Compare version B', pickB, (n) => setDiff([pickA, n]))}
        {a && b ? (
          <button type="button" className="btn btn-ghost" onClick={() => setDiff(undefined)}>
            Hide diff
          </button>
        ) : (
          <button type="button" className="btn" onClick={() => setDiff([pickA, pickB])}>
            Compare
          </button>
        )}
      </div>
      {a && b && <PromptDiff a={a} b={b} />}
    </section>
  );
}

/** The selected version: title, labels, actions and the text. */
function SelectedVersion({
  name,
  selected,
  versions,
  onMoved,
}: {
  name: string;
  selected: ObservePromptVersion;
  versions: readonly ObservePromptVersion[];
  onMoved: () => void;
}) {
  return (
    <section className="prompt-version" aria-label="Selected version">
      <div className="prompt-version-head">
        <h3 className="prompt-version-title">Version {selected.version}</h3>
        <LabelChips labels={selected.labels} />
        <span className="prompt-meta">created {fmtDateTime(selected.created_at)}</span>
        <a href={promptRunsHref(name, selected.version)}>Runs using this version ({fmtInt(selected.uses)})</a>
        <a href={promptPlaygroundHref(name, selected.version)}>Open in Playground</a>
      </div>
      <LabelMoves name={name} selected={selected} versions={versions} onMoved={onMoved} />
      <pre className="prompt-text">{selected.text ?? ''}</pre>
    </section>
  );
}

/** `#/prompts/:name[@ref]`; an unknown prompt or ref shows an empty state with the way back. */
export function PromptDetail({ param }: { param: string }) {
  const { name, ref } = parsePromptRoute(param);
  const route = useRoute();
  const [refreshKey, setRefreshKey] = useState(0);
  const history = usePromptVersions(name, refreshKey);
  const versions = history.data?.versions ?? [];
  const selected = resolveRef(versions, ref);
  const diff = parseDiff(route.query);

  let body;
  if (history.loading && !history.data) body = <p className="prompt-note">Loading prompt...</p>;
  else if (history.error) body = <ObserveError error={history.error} />;
  else if (!history.data) body = <EmptyState title="Prompt not found" hint={`No prompt '${name}'.`} action={<BackLink />} />;
  else if (!selected)
    body = <EmptyState title="Version not found" hint={`'${name}' has no version or label '${ref}'.`} action={<BackLink />} />;
  else
    body = (
      <>
        <SelectedVersion name={name} selected={selected} versions={versions} onMoved={() => setRefreshKey((k) => k + 1)} />
        <Compare name={name} refParam={ref} selected={selected} versions={versions} diff={diff} />
        <section className="prompt-history" aria-label="Version history">
          <h3 className="prompt-section-title">Version history</h3>
          <DataTable
            id="prompt-versions"
            columns={COLUMNS}
            rows={versions}
            rowKey={(v) => String(v.version)}
            selectedKey={String(selected.version)}
            onRowOpen={(v) => navigate(promptPath(name, v.version, diff), { replace: true })}
            empty={<EmptyState title="No versions" hint="This prompt has no published versions." />}
          />
        </section>
      </>
    );

  return (
    <section className="prompt-screen" aria-label="Prompt">
      <nav className="prompt-nav" aria-label="Breadcrumb">
        <BackLink />
      </nav>
      <h2 className="prompt-title">
        Prompt <code>{name}</code>
      </h2>
      {body}
    </section>
  );
}
