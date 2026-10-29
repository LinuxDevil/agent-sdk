import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { AlertCircle, ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight } from 'lucide-react';
import { isEditableTarget } from '../canvas/isEditableTarget';
import { SkeletonRows } from './Skeleton';
import './dataTable.css';

/** Default minimum column width (px) when a column sets no `minWidth`. */
const MIN_COL_WIDTH = 60;
/** Width step (px) for ArrowLeft/ArrowRight on a resize separator. */
const KEY_RESIZE_STEP = 16;
/** Upper bound reported as `aria-valuemax` on resize separators. */
const MAX_COL_WIDTH = 4000;

/** One DataTable column. `key` identifies it for sorting and width memory. */
export interface Column<T> {
  key: string;
  header: ReactNode;
  /** Text used in aria labels when `header` is not a plain string. */
  label?: string;
  /** Cell content; defaults to `String(row[key] ?? '')`. */
  render?: (r: T) => ReactNode;
  align?: 'left' | 'right';
  sortable?: boolean;
  /** Initial width in px (until the user resizes it). */
  width?: number;
  /** Minimum width in px while resizing (default 60). */
  minWidth?: number;
  /** Hide the column while the table's container is narrower than this many px. */
  hideBelow?: number;
}

/** Skeleton rows shown while a first load is in flight. */
const SKELETON_ROWS = 6;

/** The active sort: one column key and a direction. The table never sorts rows itself. */
export interface TableSort {
  key: string;
  order: 'asc' | 'desc';
}

/** Props for {@link DataTable}. */
interface DataTableProps<T> {
  /** Table id; when given, column widths persist under `forge.table.<id>.widths`. */
  id?: string;
  columns: Column<T>[];
  rows: T[];
  rowKey: (r: T) => string;
  sort?: TableSort;
  onSortChange?: (next: TableSort | undefined) => void;
  onRowOpen?: (r: T) => void;
  /** The row (by `rowKey`) shown as the current selection: `aria-current="true"` plus the selected tint. */
  selectedKey?: string;
  page?: { offset: number; limit: number; total: number; onChange: (offset: number) => void };
  density?: 'compact' | 'comfortable';
  loading?: boolean;
  empty: ReactNode;
}

type Widths = Record<string, number>;

const storageKey = (id: string) => `forge.table.${id}.widths`;

function loadWidths(id: string | undefined): Widths {
  if (!id) return {};
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(storageKey(id)) ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((e): e is [string, number] => typeof e[1] === 'number' && e[1] > 0),
    );
  } catch {
    return {};
  }
}

function saveWidths(id: string | undefined, widths: Widths) {
  if (!id) return;
  try {
    window.localStorage.setItem(storageKey(id), JSON.stringify(widths));
  } catch {
    // storage unavailable (private mode, quota): widths just aren't remembered
  }
}

/** desc -> asc -> none on the same column; a different column starts at desc. */
function nextSort(current: TableSort | undefined, key: string): TableSort | undefined {
  if (current?.key !== key) return { key, order: 'desc' };
  return current.order === 'desc' ? { key, order: 'asc' } : undefined;
}

function ariaSort(sort: TableSort | undefined, key: string): 'ascending' | 'descending' | 'none' {
  if (sort?.key !== key) return 'none';
  return sort.order === 'asc' ? 'ascending' : 'descending';
}

const columnLabel = <T,>(c: Column<T>) => c.label ?? (typeof c.header === 'string' ? c.header : c.key);
const minWidthOf = <T,>(c: Column<T>) => c.minWidth ?? MIN_COL_WIDTH;

/** Width of `ref`'s element: ResizeObserver when present, else window.innerWidth. */
function useContainerWidth(ref: RefObject<HTMLElement>): number {
  const [width, setWidth] = useState(() => window.innerWidth);
  useLayoutEffect(() => {
    const el = ref.current;
    if (typeof ResizeObserver === 'undefined' || !el) {
      const onResize = () => setWidth(window.innerWidth);
      onResize();
      window.addEventListener('resize', onResize);
      return () => window.removeEventListener('resize', onResize);
    }
    const ro = new ResizeObserver((entries) => {
      const w = entries[entries.length - 1]?.contentRect.width;
      if (typeof w === 'number') setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}

/** Column widths keyed by column key, remembered per table id. */
function useColumnWidths(id: string | undefined) {
  const [widths, setWidths] = useState<Widths>(() => loadWidths(id));
  const latest = useRef(widths);
  latest.current = widths;
  useEffect(() => setWidths(loadWidths(id)), [id]);
  const setWidth = useCallback(
    (key: string, w: number, persist: boolean) => {
      const next = { ...latest.current, [key]: Math.round(w) };
      latest.current = next;
      setWidths(next);
      if (persist) saveWidths(id, next);
    },
    [id],
  );
  const persist = useCallback(() => saveWidths(id, latest.current), [id]);
  return { widths, setWidth, persist };
}

interface ResizeHandleProps {
  label: string;
  /** Width set by the user or the column; when absent the header is measured. */
  explicit?: number;
  min: number;
  onResize: (w: number, persist: boolean) => void;
  onCommit: () => void;
}

/** Rendered width of the separator's `<th>`, re-measured after every render (0 without layout). */
function useHeaderWidth(ref: RefObject<HTMLElement>): number {
  const [measured, setMeasured] = useState(0);
  useLayoutEffect(() => {
    const w = Math.round(ref.current?.closest('th')?.getBoundingClientRect().width ?? 0);
    setMeasured(w);
  });
  return measured;
}

/** Document pointer listeners for a drag, torn down on pointerup/cancel or unmount. */
function useDragListeners() {
  const stop = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => stop.current?.(), []);
  return (onMove: (ev: PointerEvent) => void, onEnd: () => void) => {
    stop.current?.();
    const end = () => {
      teardown();
      onEnd();
    };
    const teardown = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', end);
      document.removeEventListener('pointercancel', end);
      stop.current = undefined;
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', end);
    document.addEventListener('pointercancel', end);
    stop.current = teardown;
  };
}

function ResizeHandle({ label, explicit, min, onResize, onCommit }: ResizeHandleProps) {
  const ref = useRef<HTMLDivElement>(null);
  const measured = useHeaderWidth(ref);
  const startDrag = useDragListeners();
  const clamp = (w: number) => Math.min(MAX_COL_WIDTH, Math.max(min, w));
  const width = clamp(explicit ?? measured);
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const live = e.currentTarget.closest('th')?.getBoundingClientRect().width ?? 0;
    const start = clamp(live > 0 ? live : width);
    startDrag((ev) => onResize(clamp(start + ev.clientX - startX), false), onCommit);
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const delta = e.key === 'ArrowRight' ? KEY_RESIZE_STEP : e.key === 'ArrowLeft' ? -KEY_RESIZE_STEP : 0;
    if (!delta) return;
    e.preventDefault();
    e.stopPropagation();
    onResize(clamp(width + delta), true);
  };
  return (
    <div
      ref={ref}
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${label}`}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={MAX_COL_WIDTH}
      tabIndex={0}
      className="dt-resize"
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onClick={(e) => e.stopPropagation()}
    />
  );
}

interface HeaderCellProps<T> {
  column: Column<T>;
  width?: number;
  sort?: TableSort;
  onSortChange?: (next: TableSort | undefined) => void;
  onResize: (w: number, persist: boolean) => void;
  onCommit: () => void;
}

function HeaderCell<T>({ column, width, sort, onSortChange, onResize, onCommit }: HeaderCellProps<T>) {
  const sortable = Boolean(column.sortable);
  const state = ariaSort(sort, column.key);
  const Arrow = state === 'ascending' ? ArrowUp : state === 'descending' ? ArrowDown : ArrowUpDown;
  return (
    <th
      scope="col"
      aria-sort={sortable ? state : undefined}
      className={alignClass(column)}
      style={{ minWidth: minWidthOf(column) }}
    >
      {sortable ? (
        <button type="button" className="dt-sort" onClick={() => onSortChange?.(nextSort(sort, column.key))}>
          {column.header}
          <Arrow className={state === 'none' ? 'dt-sort-arrow dt-sort-idle' : 'dt-sort-arrow'} size={14} strokeWidth={1.75} aria-hidden="true" />
        </button>
      ) : (
        <span className="dt-head">{column.header}</span>
      )}
      <ResizeHandle label={columnLabel(column)} explicit={width} min={minWidthOf(column)} onResize={onResize} onCommit={onCommit} />
    </th>
  );
}

function cellContent<T>(column: Column<T>, row: T): ReactNode {
  if (column.render) return column.render(row);
  const value = (row as Record<string, unknown>)[column.key];
  return value == null ? '' : String(value);
}

/** Plain-text cell content doubles as its tooltip, so ellipsised text stays readable. */
const titleOf = (content: ReactNode) =>
  (typeof content === 'string' && content !== '') || typeof content === 'number' ? String(content) : undefined;

const alignClass = <T,>(c: Column<T> | undefined) => (c?.align === 'right' ? 'dt-right' : undefined);

/** Props for {@link ErrorCell}. */
interface ErrorCellProps {
  children: ReactNode;
  /** Tooltip; defaults to `children` when that is a string. */
  title?: string;
}

/** An error message in a table cell: danger text behind an alert icon, truncated with a tooltip. */
export function ErrorCell({ children, title }: ErrorCellProps) {
  return (
    <span className="dt-error" title={title ?? (typeof children === 'string' ? children : undefined)}>
      <AlertCircle size={14} strokeWidth={1.75} aria-hidden="true" />
      <span className="dt-error-text">{children}</span>
    </span>
  );
}

interface BodyRowProps<T> {
  row: T;
  index: number;
  columns: Column<T>[];
  active: boolean;
  selected: boolean;
  onOpen?: (index: number) => void;
}

function BodyRow<T>({ row, index, columns, active, selected, onOpen }: BodyRowProps<T>) {
  const openable = Boolean(onOpen);
  const className = [openable && 'dt-row-open', selected && 'dt-row-selected'].filter(Boolean).join(' ');
  return (
    <tr
      data-row-index={index}
      tabIndex={openable ? (active ? 0 : -1) : undefined}
      className={className || undefined}
      aria-current={selected ? true : undefined}
      onClick={openable ? (e) => !(e.target as Element).closest('a, button, input, select, textarea') && onOpen!(index) : undefined}
    >
      {columns.map((c) => {
        const content = cellContent(c, row);
        return (
          <td key={c.key} className={alignClass(c)} title={titleOf(content)}>
            {content}
          </td>
        );
      })}
    </tr>
  );
}

/**
 * Roving-tabindex row navigation: j/ArrowDown, k/ArrowUp, Enter opens. The
 * active row is tracked by key, so it falls back to the first row when that
 * key is no longer in `rows` (next page, filter change).
 */
function useRowNavigation<T>(rows: T[], rowKey: (r: T) => string, onRowOpen: ((r: T) => void) | undefined) {
  const [activeKey, setActiveKey] = useState<string | undefined>(undefined);
  const tableRef = useRef<HTMLTableElement>(null);
  const current = Math.max(0, activeKey === undefined ? 0 : rows.findIndex((r) => rowKey(r) === activeKey));
  const setActive = (i: number) => setActiveKey(rows[i] === undefined ? undefined : rowKey(rows[i]));
  const focusRow = (i: number) => {
    setActive(i);
    tableRef.current?.querySelector<HTMLElement>(`tbody tr[data-row-index="${i}"]`)?.focus();
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLTableElement>) => {
    if (!onRowOpen || isEditableTarget(e.target)) return;
    const tr = (e.target as Element).closest?.('tbody tr[data-row-index]');
    if (!tr) return;
    const i = Number(tr.getAttribute('data-row-index'));
    if (e.key === 'j' || e.key === 'ArrowDown') {
      e.preventDefault();
      focusRow(Math.min(rows.length - 1, i + 1));
    } else if (e.key === 'k' || e.key === 'ArrowUp') {
      e.preventDefault();
      focusRow(Math.max(0, i - 1));
    } else if (e.key === 'Enter' && e.target === tr) {
      e.preventDefault();
      onRowOpen(rows[i]);
    }
  };
  const open = onRowOpen
    ? (i: number) => {
        setActive(i);
        onRowOpen(rows[i]);
      }
    : undefined;
  return { tableRef, current, onKeyDown, open };
}

/** The body with no rows: skeleton rows on a first load, else `empty` in one full-width cell. */
function EmptyBody<T>({ columns, loading, empty }: { columns: Column<T>[]; loading?: boolean; empty: ReactNode }) {
  if (loading) {
    return <SkeletonRows as="tr" rows={SKELETON_ROWS} cols={columns.length} cellClassName={(i) => alignClass(columns[i])} />;
  }
  return (
    <tr>
      <td className="dt-empty" colSpan={columns.length}>
        {empty}
      </td>
    </tr>
  );
}

function Pager({ offset, limit, total, onChange }: NonNullable<DataTableProps<unknown>['page']>) {
  const fmt = (n: number) => n.toLocaleString('en-US');
  // An offset past the end (total shrank under us) still reads as a valid range.
  const start = Math.min(offset + 1, total);
  const end = Math.max(start, Math.min(offset + limit, total));
  const range = total === 0 ? '0 of 0' : `${fmt(start)}–${fmt(end)} of ${fmt(total)}`;
  return (
    <div className="dt-pager">
      <span className="dt-pager-range">{range}</span>
      <button type="button" className="btn btn-sm" disabled={offset <= 0} onClick={() => onChange(Math.max(0, offset - limit))}>
        <ChevronLeft aria-hidden="true" />
        Previous
      </button>
      <button type="button" className="btn btn-sm" disabled={offset + limit >= total} onClick={() => onChange(offset + limit)}>
        Next
        <ChevronRight aria-hidden="true" />
      </button>
    </div>
  );
}

/**
 * The Studio's shared table: semantic `<table>`, controlled sort (server-side,
 * rows are rendered in the order given), keyboard row navigation, resizable
 * columns remembered per `id`, responsive `hideBelow` columns, and a pager.
 */
export function DataTable<T>(props: DataTableProps<T>) {
  const { id, columns, rows, rowKey, sort, onSortChange, onRowOpen, selectedKey, page, density = 'compact', loading, empty } = props;
  const wrapRef = useRef<HTMLDivElement>(null);
  const containerWidth = useContainerWidth(wrapRef);
  const { widths, setWidth, persist } = useColumnWidths(id);
  const { tableRef, current, onKeyDown, open } = useRowNavigation(rows, rowKey, onRowOpen);
  const visible = columns.filter((c) => c.hideBelow === undefined || containerWidth >= c.hideBelow);
  const widthOf = (c: Column<T>) => widths[c.key] ?? c.width;
  return (
    <div className="data-table-wrap" ref={wrapRef}>
      <table
        ref={tableRef}
        className={`data-table dt-${density}`}
        aria-busy={loading ? true : undefined}
        onKeyDown={onKeyDown}
      >
        <colgroup>
          {visible.map((c) => {
            const w = widthOf(c);
            return <col key={c.key} style={w ? { width: `${w}px` } : undefined} />;
          })}
        </colgroup>
        <thead>
          <tr>
            {visible.map((c) => (
              <HeaderCell
                key={c.key}
                column={c}
                width={widthOf(c)}
                sort={sort}
                onSortChange={onSortChange}
                onResize={(w, save) => setWidth(c.key, w, save)}
                onCommit={persist}
              />
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <EmptyBody columns={visible} loading={loading} empty={empty} />
          ) : (
            rows.map((r, i) => (
              <BodyRow
                key={rowKey(r)}
                row={r}
                index={i}
                columns={visible}
                active={i === current}
                selected={selectedKey !== undefined && rowKey(r) === selectedKey}
                onOpen={open}
              />
            ))
          )}
        </tbody>
      </table>
      {page && <Pager {...page} />}
    </div>
  );
}
