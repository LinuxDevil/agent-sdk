/**
 * Shared row helpers for the trace viewer (RunTree, Waterfall, RunInspector).
 * Not a component module: the three views import these so the tree and the
 * waterfall agree on order, duration, tokens and when to virtualise.
 */
import { useMemo } from 'react';

import { flattenObservationTree, nestObservations, type ObservationNode } from '../../observe/tree';
import type { ObserveObservationRow } from '../../observe/types';

/** Above this many observations the tree and waterfall render through `VirtualList`. */
export const VIRTUALISE_ABOVE = 500;

/** Fixed row height (px) used when virtualised; must match `.run-row-virtual` in run.css. */
export const VIRTUAL_ROW_HEIGHT = 32;

/** Nest then flatten `rows` depth-first: the display order both views share. */
export function useFlatNodes(rows: ObserveObservationRow[]): ObservationNode[] {
  return useMemo(() => flattenObservationTree(nestObservations(rows)), [rows]);
}

/** The name shown for an observation: its `name`, else a short id. */
export function displayName(row: ObserveObservationRow): string {
  return row.name ?? row.obs_id.slice(0, 12);
}

/** Total tokens (input + output) when either is reported, else `null`. */
export function totalTokens(row: ObserveObservationRow): number | null {
  if (row.usage_input_tokens === null && row.usage_output_tokens === null) return null;
  return (row.usage_input_tokens ?? 0) + (row.usage_output_tokens ?? 0);
}

/** An open observation (`end === null`) is running unless its stored status is terminal (`interrupted` by the crash sweep, or `error`). */
export function isRunning(row: ObserveObservationRow): boolean {
  return row.end === null && row.status !== 'interrupted' && row.status !== 'error';
}

/** The status to display: a stored terminal status (`error`, `interrupted`) always wins; else `running` for an open observation, else the stored status. */
export function displayStatus(row: ObserveObservationRow): string | null {
  if (row.status === 'error' || row.status === 'interrupted') return row.status;
  return isRunning(row) ? 'running' : row.status;
}

/**
 * Elapsed ms: `end - start`, or `now - start` while still running. An open
 * row with a terminal status stops at `fallbackEnd` (the latest known end
 * among it and its descendants), else at its start; it never counts to `now`.
 */
export function elapsedMs(row: ObserveObservationRow, now: number, fallbackEnd?: number): number {
  const end = row.end ?? (isRunning(row) ? now : (fallbackEnd ?? row.start));
  return Math.max(0, end - row.start);
}

/** The href that opens a generation in the Playground (it loads the trace, then pre-fills from the observation). */
export function playgroundHref(traceId: string, obsId: string): string {
  return `#/playground?trace=${encodeURIComponent(traceId)}&fromObs=${encodeURIComponent(obsId)}`;
}

/** `className` join that drops falsy entries. */
export function cx(...names: (string | false | null | undefined)[]): string {
  return names.filter(Boolean).join(' ');
}
