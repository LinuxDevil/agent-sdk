/**
 * `#/templates` - the Templates screen (A10): the SDK's shipped templates as a
 * card grid under category pills, each card opening a detail sheet whose Use
 * template creates the agent and opens its canvas. The list comes from
 * `GET /templates` (runtimeClient.listTemplates); the filter (`?category=`)
 * and the open sheet (`?template=`) live in the hash query.
 */
import { useEffect, useMemo, useState } from 'react';
import { LayoutTemplate } from 'lucide-react';
import type { TemplateSummary } from '../../../shared/wireTypes';
import { runtimeClient } from '../../runtime/runtimeClient';
import { useQueryState } from '../../router/useRoute';
import { ScreenHeader } from '../../shell/ScreenHeader';
import { EmptyState } from '../../ui/EmptyState';
import { Skeleton } from '../../ui/Skeleton';
import { LoadErrorCard, LoadingGrid } from '../listStates';
import { categoryCounts, type CategoryCount } from './templatesModel';
import { TemplateCard } from './TemplateCard';
import { TemplateSheet } from './TemplateSheet';
import './templates.css';

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** `?category=`/`?template=` are plain string keys; '' means absent. */
const parseKey = (s: string | null): string => s ?? '';
const formatKey = (v: string): string | null => (v === '' ? null : v);

/** One shimmer card standing in for a template while the list loads. */
function SkeletonCard() {
  return (
    <li className="template-card-skeleton" aria-hidden="true">
      <Skeleton width={36} height={36} radius="var(--radius)" />
      <Skeleton width="70%" height={10} />
      <Skeleton width="45%" height={10} />
      <Skeleton width="90%" height={10} />
      <Skeleton width="60%" height={10} />
    </li>
  );
}

/** The loaded grid: one TemplateCard per visible template. */
function TemplateGrid({ items, onOpen }: { items: TemplateSummary[]; onOpen(id: string): void }) {
  return (
    <ul className="templates-grid" aria-label="Templates" aria-busy="false">
      {items.map((summary) => (
        <li key={summary.id}>
          <TemplateCard summary={summary} onOpen={onOpen} />
        </li>
      ))}
    </ul>
  );
}

function useTemplateList() {
  const [items, setItems] = useState<TemplateSummary[] | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    runtimeClient
      .listTemplates()
      .then((list) => {
        if (cancelled) return;
        setItems(list);
        setError(undefined);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(messageOf(e));
      });
    return () => {
      cancelled = true;
    };
  }, [reload]);

  const onRetry = () => setReload((n) => n + 1);
  return { items, error, onRetry };
}

function CategoryPills({
  counts,
  activeCategory,
  onSelect,
}: {
  counts: CategoryCount[];
  activeCategory: string;
  onSelect(category: string): void;
}) {
  return (
    <div className="templates-filter" role="group" aria-label="Category">
      {counts.map((c) => {
        const pressed = c.value === undefined ? activeCategory === '' : c.value === activeCategory;
        return (
          <button
            key={c.label}
            type="button"
            className="templates-pill"
            aria-pressed={pressed}
            onClick={() => onSelect(c.value ?? '')}
          >
            {c.label}
            <span className="templates-pill-count tabular-nums">{c.count}</span>
          </button>
        );
      })}
    </div>
  );
}

function TemplatesBody({
  items,
  error,
  visible,
  onRetry,
  onOpen,
}: {
  items: TemplateSummary[] | undefined;
  error: string | undefined;
  visible: TemplateSummary[];
  onRetry(): void;
  onOpen(id: string): void;
}) {
  if (error !== undefined && items === undefined) {
    return <LoadErrorCard title="Could not load templates" error={error} onRetry={onRetry} />;
  }
  if (items === undefined) {
    return (
      <LoadingGrid className="templates-grid" label="Templates" status="Loading templates" skeleton={SkeletonCard} />
    );
  }
  if (items.length === 0) {
    return (
      <EmptyState
        icon={LayoutTemplate}
        title="No templates found"
        hint="The SDK ships six templates; check that the Studio server can read the SDK’s templates folder."
      />
    );
  }
  return <TemplateGrid items={visible} onOpen={onOpen} />;
}

export function TemplatesScreen() {
  const { items, error, onRetry } = useTemplateList();
  const [category, setCategory] = useQueryState('category', parseKey, formatKey);
  const [templateId, setTemplateId] = useQueryState('template', parseKey, formatKey);

  const counts = useMemo(() => (items === undefined ? [] : categoryCounts(items)), [items]);
  // A `?category=` that names no shipped category falls back to All.
  const activeCategory = counts.some((c) => c.value === category) ? category : '';
  const visible = useMemo(
    () => (items ?? []).filter((t) => activeCategory === '' || t.category === activeCategory),
    [items, activeCategory]
  );
  const selected = items?.find((t) => t.id === templateId);

  const onOpen = (id: string) => setTemplateId(id);
  const onCloseSheet = () => setTemplateId('');

  return (
    <>
      <ScreenHeader
        title="Templates"
        description="Ready-made agents to start from. Each one opens as a new agent you can change."
      />
      <div className="templates-screen">
        {items !== undefined && items.length > 0 && (
          <CategoryPills counts={counts} activeCategory={activeCategory} onSelect={setCategory} />
        )}
        <TemplatesBody items={items} error={error} visible={visible} onRetry={onRetry} onOpen={onOpen} />
        <TemplateSheet
          templateId={templateId === '' ? null : templateId}
          summary={selected}
          onClose={onCloseSheet}
        />
      </div>
    </>
  );
}
