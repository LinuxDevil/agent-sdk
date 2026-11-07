/**
 * `usePrefilledRows` — the view-state hook for a `KeyValueField` that
 * suggests a spec record's required keys as blank rows while the map is
 * empty (integration credentials, channel secrets): keys only, values are
 * never prefilled, and blank rows are display-only — an entry lands in
 * the spec only once its value is set, and a row the user removes stays
 * removed.
 */
import { useRef } from 'react';
import type { SecretRef } from '../../../shared/wireTypes';

type Rows = Record<string, string | SecretRef>;

/** `keys` as blank rows — suggestion rows carry keys only, never values. */
function blanks(keys: readonly string[]): Rows {
  return Object.fromEntries(keys.map((key) => [key, '']));
}

/** `map` without its blank-valued rows — suggestion rows are display-only and never reach the spec. */
function nonBlank(map: Rows | undefined): Rows {
  return Object.fromEntries(Object.entries(map ?? {}).filter(([, value]) => value !== ''));
}

/**
 * Returns the record the `KeyValueField` should display (`view`) and the
 * `onChange` that folds a row edit into it: `onChange` updates `view` to
 * the rows verbatim — blanks included, so typing keeps every row and a
 * removed row stays removed — and answers the spec map with blank rows
 * stripped, for the caller's `patch`. `view` is rebuilt from `map` only
 * when `map` is not the object the hook last emitted — a picker switch,
 * undo or an outside edit.
 */
export function usePrefilledRows(
  keys: readonly string[],
  map: Rows | undefined
): { view: Rows; onChange: (next: Rows | undefined) => Rows } {
  // `emitted` tracks the object the form last wrote; `view` the record the
  // rows show — our emit verbatim so `KeyValueField` (which resyncs its
  // draft rows whenever `value` is not its own echo) never drops a row.
  const emitted = useRef<Rows | undefined>(undefined);
  const view = useRef<Rows>({});
  if (emitted.current !== map) {
    emitted.current = map;
    view.current = map !== undefined && Object.keys(map).length > 0 ? map : blanks(keys);
  }
  return {
    view: view.current,
    onChange: (next) => {
      view.current = next ?? {};
      emitted.current = nonBlank(next);
      return emitted.current;
    },
  };
}
