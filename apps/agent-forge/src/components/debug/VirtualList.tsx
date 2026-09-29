import { useRef, useState, type ReactNode, type UIEvent } from 'react';

export interface VirtualListProps<T> {
  items: T[];
  rowHeight: number;
  renderRow: (item: T, index: number) => ReactNode;
  overscan?: number;
  emptyMessage?: string;
  className?: string;
}

/**
 * O1's "lightweight windowing technique" for the live log feed - a real run
 * can produce far more rows than fit comfortably in the DOM at once (up to
 * `LOG_BUFFER_CAPACITY`, see state/logReducer.ts), so this only renders the
 * rows currently scrolled into view (plus `overscan` rows of padding either
 * side) rather than every row in `items`. No virtualization library: fixed
 * `rowHeight` rows + a `scrollTop`-driven slice is enough for this app's
 * uniform-height log/trace rows, and keeps this dependency-free.
 */
export function VirtualList<T>({
  items,
  rowHeight,
  renderRow,
  overscan = 8,
  emptyMessage,
  className,
}: VirtualListProps<T>) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(300);

  function onScroll(e: UIEvent<HTMLDivElement>) {
    setScrollTop(e.currentTarget.scrollTop);
  }

  // Re-measure the viewport on mount / whenever the drawer resizes.
  const measuredRef = (node: HTMLDivElement | null) => {
    containerRef.current = node;
    if (node) setViewportHeight(node.clientHeight || 300);
  };

  if (items.length === 0) {
    return <div className="logs-empty">{emptyMessage ?? 'Nothing yet.'}</div>;
  }

  const totalHeight = items.length * rowHeight;
  const firstVisible = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const visibleCount = Math.ceil(viewportHeight / rowHeight) + overscan * 2;
  const lastVisible = Math.min(items.length, firstVisible + visibleCount);
  const offsetY = firstVisible * rowHeight;

  return (
    <div ref={measuredRef} className={className ?? 'logs-viewport'} onScroll={onScroll}>
      <div style={{ height: totalHeight, position: 'relative' }}>
        <div style={{ position: 'absolute', top: offsetY, left: 0, right: 0 }}>
          {items.slice(firstVisible, lastVisible).map((item, i) => renderRow(item, firstVisible + i))}
        </div>
      </div>
    </div>
  );
}
