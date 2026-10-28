/**
 * Filter-bar pieces shared by the list screens (`#/traces`, `#/threads`):
 * single-value facets over FilterBar's multi-select, the agent facet, the
 * URL-backed time range, and the one-line preview cell.
 */
import './listFilters.css';
import { useRef } from 'react';
import type { ObserveAgentRow } from '../observe/types';
import type { FacetDef } from '../ui/FilterBar';
import { formatTimeRange, toWindow, type TimeRange } from '../ui/TimeRangePicker';

type Window = { from: number; to: number };
type Preset = Extract<TimeRange, { preset: string }>['preset'];

/** A preview cell: one line, ellipsised by CSS, the full text in `title`. */
export function Clip({ text, className = 'list-clip' }: { text: string | null; className?: string }) {
  if (!text) return null;
  return (
    <span className={className} title={text}>
      {text}
    </span>
  );
}

/** Single-value facet over FilterBar's multi-select: the newest pick wins, clearing it drops the filter. */
export function facet(
  key: string,
  label: string,
  options: string[],
  value: string | undefined,
  set: (v: string | undefined) => void
): FacetDef {
  const all = value && !options.includes(value) ? [value, ...options] : options;
  return {
    key,
    label,
    options: all.map((o) => ({ value: o, label: o })),
    value: value ? [value] : [],
    onChange: (next) => set(next.find((v) => v !== value) ?? (value && next.includes(value) ? value : undefined)),
  };
}

/** The agent facet: values are agent ids, labels the registered names. */
export function agentFacet(agents: ObserveAgentRow[], value: string | undefined, set: (v: string | undefined) => void): FacetDef {
  const def = facet('agent', 'Agent', agents.map((a) => a.agent_id), value, set);
  const names = new Map(agents.map((a) => [a.agent_id, a.name ?? a.agent_id.slice(0, 8)]));
  return { ...def, options: def.options.map((o) => ({ ...o, label: names.get(o.value) ?? o.value })) };
}

/**
 * The time-range control for a list whose URL holds only absolute bounds.
 * `defaultPreset` is the rolling window an empty URL means; picking it clears
 * the bounds. Any other preset is snapshotted to bounds and remembered next to
 * them, so the picker keeps showing e.g. "7d" until the window changes (a
 * reload then shows it as Custom).
 */
export function useRangeFilter(
  window: Window | undefined,
  defaultPreset: Preset,
  setWindow: (w: Window | undefined) => void
): { value: TimeRange; onChange: (r: TimeRange) => void } {
  const picked = useRef<{ range: TimeRange; key: string } | undefined>(undefined);
  let value: TimeRange = { preset: defaultPreset };
  if (window) {
    const key = formatTimeRange(window);
    value = picked.current?.key === key ? picked.current.range : window;
  }
  const onChange = (r: TimeRange) => {
    if ('preset' in r && r.preset === defaultPreset) {
      picked.current = undefined;
      setWindow(undefined);
      return;
    }
    const next = toWindow(r, Date.now());
    picked.current = { range: r, key: formatTimeRange(next) };
    setWindow(next);
  };
  return { value, onChange };
}
