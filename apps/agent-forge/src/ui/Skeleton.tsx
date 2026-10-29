import type { CSSProperties } from 'react';
import './skeleton.css';

/** A length: a number is pixels, a string is any CSS length (`'60%'`, `'1.5em'`). */
type Length = number | string;

const css = (v: Length | undefined) => (typeof v === 'number' ? `${v}px` : v);

/** Props for {@link Skeleton}. */
interface SkeletonProps {
  width?: Length;
  height?: Length;
  /** Corner radius; defaults to `var(--radius-sm)`. */
  radius?: string;
  className?: string;
}

/**
 * One shimmer block standing in for content that is still loading. Purely
 * decorative (`aria-hidden`): a screen that shows only skeletons pairs them
 * with {@link SkeletonRows} or its own status text.
 */
export function Skeleton({ width, height, radius = 'var(--radius-sm)', className }: SkeletonProps) {
  const style: CSSProperties = { width: css(width), height: css(height), borderRadius: radius };
  return <span className={className ? `skeleton ${className}` : 'skeleton'} style={style} aria-hidden="true" />;
}

/** Cell widths cycled down the rows, so a block reads as ragged text rather than bars. */
const WIDTHS = ['72%', '56%', '84%', '48%', '64%', '78%'];
const widthAt = (row: number, col: number) => WIDTHS[(row * 2 + col) % WIDTHS.length];

/** Props for {@link SkeletonRows}. */
interface SkeletonRowsProps {
  /** Number of rows (default 6). */
  rows?: number;
  /** Blocks per row (default 1). */
  cols?: number;
  /** `'tr'` renders table rows of `<td>`s for a `<tbody>`; `'div'` (default) a stack of flex rows. */
  as?: 'div' | 'tr';
  /** Extra class for the cell at column `index` (table alignment, e.g. `'dt-right'`). */
  cellClassName?: (index: number) => string | undefined;
}

const Status = () => (
  <span role="status" className="visually-hidden">
    Loading
  </span>
);

/** Table rows: the status sits in the first cell; the other rows are hidden from assistive tech. */
function TableRows({ rows, cols, cellClassName }: Required<Omit<SkeletonRowsProps, 'as'>>) {
  return (
    <>
      {Array.from({ length: rows }, (_, r) => (
        <tr key={r} className="skeleton-row" aria-hidden={r > 0 ? true : undefined}>
          {Array.from({ length: cols }, (_, c) => (
            <td key={c} className={cellClassName(c)}>
              {r === 0 && c === 0 && <Status />}
              <Skeleton width={widthAt(r, c)} height={10} />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

/**
 * A block of shimmer rows with ONE visually-hidden `role="status"` "Loading"
 * text: the loading state for tables and lists. Static under reduced motion.
 */
export function SkeletonRows({ rows = 6, cols = 1, as = 'div', cellClassName = () => undefined }: SkeletonRowsProps) {
  if (as === 'tr') return <TableRows rows={rows} cols={cols} cellClassName={cellClassName} />;
  return (
    <div className="skeleton-rows">
      <Status />
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="skeleton-row">
          {Array.from({ length: cols }, (_, c) => (
            <span key={c} className={['skeleton-cell', cellClassName(c)].filter(Boolean).join(' ')}>
              <Skeleton width={widthAt(r, c)} height={10} />
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}
