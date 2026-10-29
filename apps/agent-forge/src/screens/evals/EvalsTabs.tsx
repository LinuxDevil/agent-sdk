/**
 * The Evaluations sub-navigation shown in the header of every `#/evals/*`
 * screen, so Scores, Datasets, Evaluators and Annotation queues reach each
 * other. The tab owning the current route's second segment gets
 * `aria-current="page"`.
 */
import './evals.css';
import { useRoute } from '../../router/useRoute';
import { ScreenHeader, type ScreenHeaderProps } from '../../shell/ScreenHeader';

const TABS = [
  { section: 'scores', label: 'Scores' },
  { section: 'datasets', label: 'Datasets' },
  { section: 'evaluators', label: 'Evaluators' },
  { section: 'queues', label: 'Annotation queues' },
] as const;

/** `<nav aria-label="Evaluations">`: one underline tab per Evaluations screen. */
export function EvalsTabs() {
  const { path } = useRoute();
  const current = path.split('/').filter(Boolean)[1];
  return (
    <nav className="evals-tabs" aria-label="Evaluations">
      {TABS.map(({ section, label }) => (
        <a
          key={section}
          className="evals-tab"
          href={`#/evals/${section}`}
          aria-current={section === current ? 'page' : undefined}
        >
          {label}
        </a>
      ))}
    </nav>
  );
}

/**
 * The header of an Evaluations screen: title "Evaluations" (a detail view passes
 * its own title and breadcrumbs), no run status, and the {@link EvalsTabs} row.
 */
export function EvalsHeader(props: Omit<ScreenHeaderProps, 'tabs' | 'status'>) {
  return <ScreenHeader title="Evaluations" {...props} status={null} tabs={<EvalsTabs />} />;
}
