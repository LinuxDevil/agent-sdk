/**
 * The Evaluations sub-navigation shown atop every `#/evals/*` screen, so
 * Scores, Datasets, Evaluators and Annotation queues reach each other. The
 * tab owning the current route's second segment gets `aria-current="page"`.
 */
import './evals.css';
import { useRoute } from '../../router/useRoute';

const TABS = [
  { section: 'scores', label: 'Scores' },
  { section: 'datasets', label: 'Datasets' },
  { section: 'evaluators', label: 'Evaluators' },
  { section: 'queues', label: 'Annotation queues' },
] as const;

/** `<nav aria-label="Evaluations">`: one link per Evaluations screen. */
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
