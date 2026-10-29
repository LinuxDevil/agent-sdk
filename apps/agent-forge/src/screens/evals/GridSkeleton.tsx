/**
 * The first-load placeholder of an Evaluations card grid (`ds-grid`, see
 * evals.css): six skeleton cards and one visually hidden status line.
 */
import { Skeleton } from '../../ui/Skeleton';

/** Six shimmer cards; `label` is the status text screen readers hear ("Loading evaluators"). */
export function GridSkeleton({ label }: { label: string }) {
  return (
    <div className="ds-grid-loading">
      <span role="status" className="visually-hidden">
        {label}
      </span>
      <ul className="ds-grid" aria-hidden="true">
        {Array.from({ length: 6 }, (_, i) => (
          <li key={i} className="ds-card ds-card-skeleton">
            <Skeleton width={28} height={28} radius="var(--radius)" />
            <Skeleton width="55%" height={12} />
            <Skeleton width="85%" height={10} />
            <Skeleton width="40%" height={10} />
          </li>
        ))}
      </ul>
    </div>
  );
}
