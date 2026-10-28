import type { ReactNode } from 'react';

import { VirtualList } from '../../components/debug/VirtualList';
import { fmtDuration, fmtInt } from '../../observe/format';
import type { ObservationNode } from '../../observe/tree';
import type { ObserveObservationRow } from '../../observe/types';
import { StatusPill } from '../StatusPill';
import {
  VIRTUALISE_ABOVE,
  VIRTUAL_ROW_HEIGHT,
  cx,
  displayName,
  displayStatus,
  elapsedMs,
  isRunning,
  playgroundHref,
  totalTokens,
  useFlatNodes,
} from './rows';
import './run.css';

/**
 * Props for {@link RunTree}. `observations` are a trace's flat rows as the
 * daemon returns them (nested here by `parent_obs_id`); `now` is the clock an
 * open observation's running duration counts to (defaults to `Date.now()`).
 * `playgroundLinks: false` hides the generation rows' "Open in Playground" link.
 */
export interface RunTreeProps {
  observations: ObserveObservationRow[];
  selectedObsId?: string | null;
  onSelect: (obsId: string) => void;
  now?: number;
  playgroundLinks?: boolean;
}

const INDENT_PX = 16;

/** One small 16px glyph per observation kind; anything unknown gets the generic dot. */
const KIND_ICON: Record<string, ReactNode> = {
  span: <path d="M4 7h16M4 12h10M4 17h6" />,
  generation: <path d="M12 3l2.2 5.8L20 11l-5.8 2.2L12 19l-2.2-5.8L4 11l5.8-2.2z" />,
  tool: <path d="M14.5 5.5a4 4 0 0 0-5 5L4 16l4 4 5.5-5.5a4 4 0 0 0 5-5l-2.5 2.5-2-2z" />,
  event: <path d="M13 3L5 14h6l-1 7 8-11h-6z" />,
};
const GENERIC_ICON = <circle cx="12" cy="12" r="4" />;

function KindIcon({ kind }: { kind: string }) {
  const known = Object.hasOwn(KIND_ICON, kind);
  return (
    <span className={cx('run-kind', `run-kind-${known ? kind : 'other'}`)} data-kind={kind} title={kind}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        {known ? KIND_ICON[kind] : GENERIC_ICON}
      </svg>
      <span className="visually-hidden">{kind}</span>
    </span>
  );
}

function Duration({ row, now }: { row: ObserveObservationRow; now: number }) {
  const ms = elapsedMs(row, now);
  if (isRunning(row)) return <span className="run-dur run-dur-live">{fmtDuration(ms)} running</span>;
  return <span className="run-dur">{fmtDuration(ms)}</span>;
}

interface TreeRowProps {
  node: ObservationNode;
  selected: boolean;
  virtual: boolean;
  now: number;
  playgroundLinks: boolean;
  onSelect: (obsId: string) => void;
}

function TreeRow({ node, selected, virtual, now, playgroundLinks, onSelect }: TreeRowProps) {
  const { row } = node;
  const tokens = totalTokens(row);
  const status = displayStatus(row);
  const name = displayName(row);
  return (
    <div
      className={cx('run-row', 'run-tree-row', virtual && 'run-row-virtual', selected && 'selected', row.status === 'error' && 'run-row-error')}
      data-obs-id={row.obs_id}
      data-depth={node.depth}
    >
      <button
        type="button"
        className="run-row-main"
        style={{ paddingLeft: 8 + node.depth * INDENT_PX }}
        aria-current={selected ? 'true' : undefined}
        onClick={() => onSelect(row.obs_id)}
      >
        <KindIcon kind={row.kind} />
        <span className="run-name" title={row.name ?? row.obs_id}>
          {name}
        </span>
        {status !== 'ok' && status !== null && <StatusPill status={status} />}
        {row.model && <span className="run-model-chip">{row.model}</span>}
        {tokens !== null && <span className="run-tokens">{fmtInt(tokens)} tok</span>}
        <Duration row={row} now={now} />
      </button>
      {playgroundLinks && row.kind === 'generation' && (
        <a className="run-playground-link" href={playgroundHref(row.trace_id, row.obs_id)} title={`Open ${name} in Playground`}>
          Open in Playground
        </a>
      )}
    </div>
  );
}

/**
 * The trace as an indented tree, one row per observation in depth-first
 * order: kind icon, full name (wraps; virtualised rows keep a `title`
 * tooltip), status when not ok, model chip, total tokens and duration.
 * Generation rows carry an "Open in Playground" link. Above 500 observations
 * the rows render through `VirtualList` at a fixed height.
 */
export function RunTree({ observations, selectedObsId, onSelect, now, playgroundLinks = true }: RunTreeProps) {
  const nodes = useFlatNodes(observations);
  const clock = now ?? Date.now();
  const virtual = nodes.length > VIRTUALISE_ABOVE;
  const renderRow = (node: ObservationNode) => (
    <TreeRow
      key={node.row.obs_id}
      node={node}
      selected={node.row.obs_id === selectedObsId}
      virtual={virtual}
      now={clock}
      playgroundLinks={playgroundLinks}
      onSelect={onSelect}
    />
  );
  if (virtual) {
    return (
      <div className="run-tree" role="group" aria-label="Run tree">
        <VirtualList items={nodes} rowHeight={VIRTUAL_ROW_HEIGHT} renderRow={renderRow} className="run-virtual" />
      </div>
    );
  }
  return (
    <div className="run-tree" role="group" aria-label="Run tree">
      {nodes.map(renderRow)}
    </div>
  );
}
