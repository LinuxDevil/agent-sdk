/**
 * `#/prompts` - the prompt registry (`GET /api/v1/prompts`: one row per name,
 * its latest version) - and `#/prompts/:name[@ref]`, one prompt's history,
 * diff and labels (see `PromptDetail.tsx`). URL shapes are in `promptsUrl.ts`.
 * Both routes sit behind the daemon-down state, which keeps the URL and swaps
 * the screen back in by itself once the health probe sees the daemon.
 */
import './prompts.css';
import { useState } from 'react';
import { FileText, SearchX } from 'lucide-react';
import { matchRoute, navigate } from '../../router/router';
import { useRoute } from '../../router/useRoute';
import { useDaemonDown, useDaemonHealth, usePrompts } from '../../observe/useObserve';
import { ObserveDaemonDown, ObserveError } from '../../observe/chrome';
import type { ObservePromptRow } from '../../observe/types';
import { fmtDateTime, fmtInt } from '../../observe/format';
import { ScreenHeader } from '../../shell/ScreenHeader';
import { Card } from '../../ui/Card';
import { DataTable, type Column } from '../../ui/DataTable';
import { EmptyState } from '../../ui/EmptyState';
import { FilterBar } from '../../ui/FilterBar';
import { Clip } from '../listFilters';
import { LabelChips } from './LabelChips';
import { PromptDetail } from './PromptDetail';
import { promptPath } from './promptsUrl';

const COLUMNS: Column<ObservePromptRow>[] = [
  {
    key: 'name',
    header: 'Name',
    width: 240,
    render: (p) => (
      <span className="prompt-name-cell">
        <FileText size={16} strokeWidth={1.75} aria-hidden="true" />
        <Clip text={p.name} className="list-clip prompt-name" />
      </span>
    ),
  },
  { key: 'latest', header: 'Latest', width: 80, render: (p) => <span className="prompt-version-badge">v{p.version}</span> },
  { key: 'labels', header: 'Labels', width: 220, render: (p) => <LabelChips labels={p.labels} /> },
  { key: 'versions', header: 'Versions', align: 'right', width: 90, render: (p) => fmtInt(p.versions) },
  { key: 'uses', header: 'Used by', label: 'Used by (runs)', align: 'right', width: 90, render: (p) => fmtInt(p.uses) },
  { key: 'updated', header: 'Updated', width: 140, hideBelow: 720, render: (p) => fmtDateTime(p.created_at) },
];

const HEADER = <ScreenHeader title="Prompts" status={null} description="Versioned prompt templates and the labels that pin a version." />;

function PromptList() {
  const prompts = usePrompts();
  // Client-side only: a substring filter over the loaded rows, never written to the URL.
  const [query, setQuery] = useState('');
  if (useDaemonDown(false, [prompts])) return <ObserveDaemonDown />;
  const all = prompts.data ?? [];
  const needle = query.trim().toLowerCase();
  const rows = needle ? all.filter((p) => p.name.toLowerCase().includes(needle)) : all;
  const filtered = needle !== '' && all.length > 0;
  return (
    <section className="prompts-screen" aria-label="Prompts">
      {HEADER}
      <h2 className="visually-hidden">Prompts</h2>
      <ObserveError error={prompts.error} />
      <Card
        title="Registry"
        description={prompts.data ? `${fmtInt(all.length)} ${all.length === 1 ? 'prompt' : 'prompts'}` : undefined}
        actions={<FilterBar search={{ value: query, onChange: setQuery, placeholder: 'Search prompts' }} facets={[]} />}
        padding="none"
        className="prompts-card"
      >
        <DataTable
          id="prompts"
          columns={COLUMNS}
          rows={rows}
          rowKey={(p) => p.name}
          onRowOpen={(p) => navigate(promptPath(p.name))}
          loading={prompts.loading}
          empty={
            filtered ? (
              <EmptyState icon={SearchX} title="No matching prompts" hint={`No prompt name contains "${query.trim()}".`} />
            ) : (
              <EmptyState
                icon={FileText}
                title="No prompts yet"
                hint="Publish one with `lousho prompt push <file>` (or POST /api/v1/prompts); its versions and labels show up here."
              />
            )
          }
        />
      </Card>
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
