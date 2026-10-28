/**
 * The Datasets screen's URL state.
 *
 * - `#/evals/datasets[?offset=]` - the dataset list.
 * - `#/evals/datasets/:name[?offset=]` - one dataset's examples; `:name` is
 *   the URL-encoded dataset name (the daemon addresses datasets by name).
 *
 * `offset` pages server-side; the default `0` is never written.
 */
import { toInt } from '../urlState';

/** Datasets per list page, requested from the daemon (`limit`). */
export const DATASETS_PAGE_SIZE = 50;
/** Examples per detail page, requested from the daemon (`limit`). */
export const EXAMPLES_PAGE_SIZE = 50;

/** The `?offset=` page start, `0` when missing or malformed. */
export const parseOffset = (query: URLSearchParams): number => toInt(query.get('offset')) ?? 0;

const withOffset = (path: string, offset: number | undefined): string => (offset ? `${path}?offset=${offset}` : path);

/** The hash path of the dataset list at `offset`. */
export const datasetsPath = (offset?: number): string => withOffset('/evals/datasets', offset);

/** The hash path of one dataset's examples at `offset`. */
export const datasetPath = (name: string, offset?: number): string =>
  withOffset(`/evals/datasets/${encodeURIComponent(name)}`, offset);

/** A one-line preview of an example's `input`/`expected` JSON value (strings verbatim). */
export function valuePreview(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : JSON.stringify(value);
}
