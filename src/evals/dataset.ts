/**
 * The cases of a `defineEval({ dataset: 'name' })` eval: the examples of a
 * dataset in the observe daemon's registry (`GET /api/v1/datasets/:name`),
 * fetched page by page at vitest collection. Every failure is
 * `LOUSHO_DATASET_UNAVAILABLE`, and so is an empty dataset: an eval that runs
 * no case must never pass green.
 */

import { SDKError } from '../execution/errors';
import { observeRequest } from '../observe/httpClient';

/** The `c` a dataset eval's `test(t, c)` receives: one daemon example. */
export interface DatasetCase {
  /** The example's input (any JSON value). */
  input: unknown;
  /** The example's expected value, `null` when the example has none. */
  expected: unknown | null;
  /** `#1`, `#2`, ... in the daemon's order (oldest first); names the test `<eval> [#1]`. */
  label: string;
  /** The daemon's id of the example. */
  example_id: string;
  /** The trace the example was copied from (`from_trace_id`), else `null`. */
  source_trace_id: string | null;
}

interface ExampleRow {
  example_id: string;
  input: unknown;
  expected?: unknown;
  source_trace_id?: string | null;
}

interface DatasetPage {
  examples?: unknown;
  total?: unknown;
}

/** Where the daemon is: `LOUSHO_OBSERVE`'s URL (undefined when unset) and its token. */
export interface DatasetSource {
  url: string | undefined;
  token?: string;
}

const PAGE_LIMIT = 1000;
const REQUEST_TIMEOUT_MS = 10_000;

function unavailable(message: string, cause?: unknown): SDKError {
  return new SDKError(message, 'LOUSHO_DATASET_UNAVAILABLE', cause === undefined ? {} : { cause });
}

async function fetchPage(name: string, url: string, token: string | undefined, offset: number): Promise<DatasetPage | undefined> {
  const path = `/api/v1/datasets/${encodeURIComponent(name)}?limit=${PAGE_LIMIT}&offset=${offset}`;
  try {
    return await observeRequest<DatasetPage | undefined>(url, path, { method: 'GET' }, REQUEST_TIMEOUT_MS, token ? { token } : {});
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const notFound = /answered 404/.test(detail) ? `dataset '${name}' was not found on the observe daemon at ${url}` : undefined;
    throw unavailable(notFound ?? `Could not fetch dataset '${name}' from the observe daemon at ${url}: ${detail}`, error);
  }
}

/** Every example of dataset `name`, oldest first, as eval cases labelled `#1`, `#2`, .... */
export async function fetchDatasetCases(name: string, source: DatasetSource): Promise<DatasetCase[]> {
  const { url, token } = source;
  if (!url) throw unavailable(`defineEval({ dataset: '${name}' }) needs the observe daemon: set LOUSHO_OBSERVE to its URL`);
  const rows: ExampleRow[] = [];
  for (;;) {
    const page = await fetchPage(name, url, token, rows.length);
    if (!page || !Array.isArray(page.examples)) {
      throw unavailable(`The observe daemon at ${url} answered dataset '${name}' without an examples array`);
    }
    rows.push(...(page.examples as ExampleRow[]));
    const total = typeof page.total === 'number' ? page.total : rows.length;
    // An empty page ends the loop even if `total` says more, so a shrinking dataset cannot spin it.
    if (rows.length >= total || page.examples.length === 0) break;
  }
  if (rows.length === 0) throw unavailable(`dataset '${name}' on the observe daemon at ${url} is empty; add examples before running the eval`);
  return rows.map((row, index) => ({
    input: row.input,
    expected: row.expected ?? null,
    label: `#${index + 1}`,
    example_id: row.example_id,
    source_trace_id: row.source_trace_id ?? null,
  }));
}
