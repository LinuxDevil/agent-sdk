/**
 * `#/prompts` - the prompt registry (`GET /api/v1/prompts`: one row per name,
 * its latest version) - and `#/prompts/:name[@ref]`, one prompt's history,
 * diff and labels (see `PromptDetail.tsx`). URL shapes are in `promptsUrl.ts`.
 * Both routes sit behind the daemon-down state, which keeps the URL and swaps
 * the screen back in by itself once the health probe sees the daemon.
 */
import './prompts.css';
import { matchRoute, navigate } from '../../router/router';
import { useRoute } from '../../router/useRoute';
import { useDaemonHealth, usePrompts } from '../../observe/useObserve';
import { ObserveDaemonDown, ObserveError } from '../../observe/chrome';
import { ObserveDaemonDownError } from '../../observe/observeClient';
import type { ObservePromptRow } from '../../observe/types';
import { fmtDateTime, fmtInt } from '../../observe/format';
import { DataTable, type Column } from '../../ui/DataTable';
import { EmptyState } from '../../ui/EmptyState';
import { Clip } from '../listFilters';
import { LabelChips } from './LabelChips';
import { PromptDetail } from './PromptDetail';
import { promptPath } from './promptsUrl';

const COLUMNS: Column<ObservePromptRow>[] = [
  { key: 'name', header: 'Name', width: 220, render: (p) => <Clip text={p.name} /> },
  { key: 'latest', header: 'Latest', width: 80, render: (p) => `v${p.version}` },
  { key: 'labels', header: 'Labels', width: 220, render: (p) => <LabelChips labels={p.labels} /> },
  { key: 'versions', header: 'Versions', align: 'right', width: 90, render: (p) => fmtInt(p.versions) },
  { key: 'uses', header: 'Used by', label: 'Used by (runs)', align: 'right', width: 90, render: (p) => fmtInt(p.uses) },
  { key: 'updated', header: 'Updated', width: 140, hideBelow: 720, render: (p) => fmtDateTime(p.created_at) },
];

function PromptList() {
  const prompts = usePrompts();
  if (prompts.error instanceof ObserveDaemonDownError) return <ObserveDaemonDown />;
  return (
    <section className="prompts-screen" aria-label="Prompts">
      <h2 className="visually-hidden">Prompts</h2>
      <ObserveError error={prompts.error} />
      <DataTable
        id="prompts"
        columns={COLUMNS}
        rows={prompts.data ?? []}
        rowKey={(p) => p.name}
        onRowOpen={(p) => navigate(promptPath(p.name))}
        loading={prompts.loading}
        empty={
          <EmptyState
            title="No prompts yet"
            hint="Publish one with `lousho prompt push <file>` (or POST /api/v1/prompts); its versions and labels show up here."
          />
        }
      />
    </section>
  );
}

/** `#/prompts` and `#/prompts/:name[@ref]`, behind the daemon-down state. */
export function PromptsScreen() {
  const { path } = useRoute();
  const health = useDaemonHealth();
  if (health.down) return <ObserveDaemonDown />;
  const detail = matchRoute(`#${path}`, ['/prompts/:name']);
  return detail ? <PromptDetail param={detail.params.name} /> : <PromptList />;
}
