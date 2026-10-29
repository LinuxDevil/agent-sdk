/**
 * `#/prompts/:name[@ref]` - one prompt: the selected version (its text with
 * line numbers, labels, "Move <label> here"), a unified or side-by-side diff
 * between any two versions (`?diff=a,b`), and the version history timeline;
 * the header carries the runs and Playground links.
 *
 * Reads `GET /api/v1/prompts/:name` (every version, text included, newest
 * first); a label move is `PUT /api/v1/prompts/:name/labels/:label` through
 * the studio proxy's write allowlist, then a refetch. Selecting a version or
 * changing the diff replaces the history entry, so Back leaves the prompt.
 */
import { useState } from 'react';
import { ArrowLeft, FileQuestion, FlaskConical, GitCompareArrows, ListTree, MoveRight, X } from 'lucide-react';
import { navigate } from '../../router/router';
import { useRoute } from '../../router/useRoute';
import { useDaemonDown, usePromptVersions } from '../../observe/useObserve';
import { ObserveDaemonDown, ObserveError } from '../../observe/chrome';
import { observeClient } from '../../observe/observeClient';
import type { ObservePromptVersion } from '../../observe/types';
import { fmtDateTime, fmtInt } from '../../observe/format';
import { ScreenHeader } from '../../shell/ScreenHeader';
import { Card } from '../../ui/Card';
import { EmptyState } from '../../ui/EmptyState';
import { SkeletonRows } from '../../ui/Skeleton';
import { useToast } from '../../ui/Toast';
import { LabelChips } from './LabelChips';
import { DiffLayoutToggle, PromptDiff, type DiffLayout } from './PromptDiff';
import { VersionTimeline, variablesText } from './VersionTimeline';
import { parseDiff, parsePromptRoute, promptPath, promptPlaygroundHref, promptRunsHref, resolveRef } from './promptsUrl';

const BackLink = () => (
  <a className="btn prompt-link-btn" href="#/prompts">
    <ArrowLeft aria-hidden="true" />
    Back to prompts
  </a>
);

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
        <button key={label} type="button" className="btn btn-sm" disabled={pending !== undefined} onClick={() => void move(label)}>
          <MoveRight aria-hidden="true" />
          Move {label} here
        </button>
      ))}
    </div>
  );
}

/** The A/B pickers, the layout toggle and, when `?diff=a,b` names two known versions, the diff itself. */
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
  const [layout, setLayout] = useState<DiffLayout>('unified');
  const find = (n: number) => versions.find((v) => v.version === n);
  const a = diff && find(diff[0]);
  const b = diff && find(diff[1]);
  // Default pair: the version before the selected one, then the selected one.
  const previous = versions.find((v) => v.version < selected.version) ?? selected;
  const pickA = a?.version ?? previous.version;
  const pickB = b?.version ?? selected.version;
  const setDiff = (next: [number, number] | undefined) => navigate(promptPath(name, refParam, next), { replace: true });

  const picker = (label: string, value: number, onChange: (n: number) => void) => (
    <select className="select prompt-picker" aria-label={label} value={value} onChange={(e) => onChange(Number(e.target.value))}>
      {versions.map((v) => (
        <option key={v.version} value={v.version}>
          v{v.version}
          {v.labels.length > 0 ? ` (${v.labels.join(', ')})` : ''}
        </option>
      ))}
    </select>
  );

  return (
    <Card
      title="Compare versions"
      description="Line diff between any two versions."
      actions={a && b ? <DiffLayoutToggle value={layout} onChange={setLayout} /> : undefined}
      className="prompt-compare"
    >
      <div className="prompt-compare-bar">
        {picker('Compare version A', pickA, (n) => setDiff([n, pickB]))}
        <span className="prompt-compare-vs" aria-hidden="true">
          vs
        </span>
        {picker('Compare version B', pickB, (n) => setDiff([pickA, n]))}
        {a && b ? (
          <button type="button" className="btn btn-ghost" onClick={() => setDiff(undefined)}>
            <X aria-hidden="true" />
            Hide diff
          </button>
        ) : (
          <button type="button" className="btn" onClick={() => setDiff([pickA, pickB])}>
            <GitCompareArrows aria-hidden="true" />
            Compare
          </button>
        )}
      </div>
      {a && b && <PromptDiff a={a} b={b} layout={layout} />}
    </Card>
  );
}

/** The version's text, one line per row with a faint line number drawn by CSS (so copying takes the text only). */
function PromptText({ text }: { text: string }) {
  const lines = text.split('\n');
  return (
    <pre className="prompt-text" tabIndex={0} aria-label="Prompt text">
      {lines.map((line, i) => (
        <span key={i} className="prompt-line">
          {line}
          {i < lines.length - 1 ? '\n' : ''}
        </span>
      ))}
    </pre>
  );
}

/** The selected version: number, labels, meta, the label moves and the text. */
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
  const variables = variablesText(selected.variables);
  return (
    <Card
      title={<span className="prompt-version-title">Version {selected.version}</span>}
      actions={<LabelMoves name={name} selected={selected} versions={versions} onMoved={onMoved} />}
      className="prompt-version"
    >
      <div className="prompt-version-head">
        <LabelChips labels={selected.labels} />
        <span className="prompt-meta">Created {fmtDateTime(selected.created_at)}</span>
        {variables && (
          <span className="prompt-meta">
            Variables <code className="prompt-vars">{variables}</code>
          </span>
        )}
        {selected.hash && (
          <span className="prompt-meta">
            Hash <code className="prompt-vars">{selected.hash.slice(0, 10)}</code>
          </span>
        )}
      </div>
      <PromptText text={selected.text ?? ''} />
    </Card>
  );
}

/** The page header: breadcrumbs, the name, the selected version's labels, and its runs / Playground links. */
function PromptHeader({ name, selected, latest }: { name: string; selected?: ObservePromptVersion; latest: boolean }) {
  return (
    <ScreenHeader
      title={name}
      breadcrumbs={[{ label: 'Prompts', href: '#/prompts' }, { label: name }]}
      status={selected ? <LabelChips labels={latest ? [...selected.labels, 'latest'] : selected.labels} /> : null}
      actions={
        selected && (
          <>
            <a className="btn prompt-link-btn" href={promptRunsHref(name, selected.version)}>
              <ListTree aria-hidden="true" />
              Runs using this version ({fmtInt(selected.uses)})
            </a>
            <a className="btn btn-primary prompt-link-btn" href={promptPlaygroundHref(name, selected.version)}>
              <FlaskConical aria-hidden="true" />
              Open in Playground
            </a>
          </>
        )
      }
    />
  );
}

/** `#/prompts/:name[@ref]`; an unknown prompt or ref shows an empty state with the way back. */
export function PromptDetail({ param }: { param: string }) {
  const { name, ref } = parsePromptRoute(param);
  const route = useRoute();
  const [refreshKey, setRefreshKey] = useState(0);
  const history = usePromptVersions(name, refreshKey);
  const down = useDaemonDown(false, [history]);
  const versions = history.data?.versions ?? [];
  const selected = resolveRef(versions, ref);
  const diff = parseDiff(route.query);
  if (down) return <ObserveDaemonDown />;

  let body;
  if (history.loading && !history.data)
    body = (
      <Card>
        <SkeletonRows rows={8} />
      </Card>
    );
  else if (history.error) body = <ObserveError error={history.error} />;
  else if (!history.data)
    body = <EmptyState icon={FileQuestion} title="Prompt not found" hint={`No prompt '${name}'.`} action={<BackLink />} />;
  else if (!selected)
    body = (
      <EmptyState icon={FileQuestion} title="Version not found" hint={`'${name}' has no version or label '${ref}'.`} action={<BackLink />} />
    );
  else
    body = (
      <div className="prompt-detail-grid">
        <div className="prompt-detail-main">
          <SelectedVersion name={name} selected={selected} versions={versions} onMoved={() => setRefreshKey((k) => k + 1)} />
          <Compare name={name} refParam={ref} selected={selected} versions={versions} diff={diff} />
        </div>
        <VersionTimeline versions={versions} selected={selected} onOpen={(v) => navigate(promptPath(name, v.version, diff), { replace: true })} />
      </div>
    );

  return (
    <section className="prompt-screen" aria-label="Prompt">
      <PromptHeader name={name} selected={selected} latest={selected !== undefined && selected === versions[0]} />
      <h2 className="visually-hidden">Prompt {name}</h2>
      {body}
    </section>
  );
}
