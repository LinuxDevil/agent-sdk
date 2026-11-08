import type { ComponentType } from 'react';
import { CircleAlert } from 'lucide-react';
import { Card } from '../ui/Card';
import { EmptyState } from '../ui/EmptyState';

const SKELETON_CARDS = 6;

/** A card list's first-load grid: six skeleton cards plus one hidden status line. */
export function LoadingGrid({
  className,
  label,
  status,
  skeleton: SkeletonCard,
}: {
  className: string;
  label: string;
  status: string;
  skeleton: ComponentType;
}) {
  return (
    <ul className={className} aria-label={label} aria-busy="true">
      <li role="status" className="visually-hidden">
        {status}
      </li>
      {Array.from({ length: SKELETON_CARDS }, (_, index) => (
        <SkeletonCard key={index} />
      ))}
    </ul>
  );
}

/** A card list's load-error card with Retry. */
export function LoadErrorCard({ title, error, onRetry }: { title: string; error: string; onRetry(): void }) {
  return (
    <Card as="div">
      <EmptyState
        icon={CircleAlert}
        title={title}
        hint={error}
        action={
          <button type="button" className="btn" onClick={onRetry}>
            Retry
          </button>
        }
      />
    </Card>
  );
}
