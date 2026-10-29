import { Bot, Circle, FlaskConical, Layers, Sparkles, Wrench, Zap, type LucideIcon } from 'lucide-react';

import { VirtualList } from '../../components/debug/VirtualList';
import { fmtDuration, fmtInt } from '../../observe/format';
import { latestKnownEnd, type ObservationNode } from '../../observe/tree';
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

/** One lucide icon per observation kind; anything unknown gets the generic circle. */
const KIND_ICON: Record<string, LucideIcon> = {
  agent: Bot,
  span: Layers,
  generation: Sparkles,
  tool: Wrench,
  event: Zap,
};

/** The kind as a small tinted icon tile (`.run-kind-<kind>`, `other` when unknown), the kind name for screen readers. */
export function KindIcon({ kind }: { kind: string }) {
  const known = Object.hasOwn(KIND_ICON, kind);
  const Icon = known ? KIND_ICON[kind] : Circle;
  return (
    <span className={cx('run-kind', `run-kind-${known ? kind : 'other'}`)} data-kind={kind} title={kind}>
      <Icon size={12} strokeWidth={2} aria-hidden="true" />
      <span className="visually-hidden">{kind}</span>
    </span>
  );
}

function Duration({ node, now }: { node: ObservationNode; now: number }) {
  const { row } = node;
  const ms = elapsedMs(row, now, !isRunning(row) && row.end === null ? latestKnownEnd(node) : undefined);
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
      {node.depth > 0 && <span className="run-guides" style={{ width: node.depth * INDENT_PX }} aria-hidden="true" />}
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
        <Duration node={node} now={now} />
      </button>
      {playgroundLinks &&
        (row.kind === 'generation' ? (
          <a className="run-playground-link" href={playgroundHref(row.trace_id, row.obs_id)} title={`Open ${name} in Playground`}>
            <FlaskConical size={14} strokeWidth={1.75} aria-hidden="true" />
            <span className="visually-hidden">Open in Playground</span>
          </a>
        ) : (
          // Every row reserves the link's slot, so the durations line up in one column.
          <span className="run-row-slot" aria-hidden="true" />
        ))}
    </div>
  );
}

/**
 * The trace as an indented tree (with indent guides), one row per observation
 * in depth-first order: kind icon tile, full name (wraps; virtualised rows keep a `title`
 * tooltip), status when not ok, model chip, total tokens and duration.
 * Generation rows carry an "Open in Playground" icon link (other rows keep
 * its slot empty, so durations align); in a pane under 420 px the model chip
 * and token count drop out, so each row stays on one line. Above 500 observations
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
