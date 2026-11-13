/**
 * datasetClient: the eval gate's read of the observe daemon's datasets API
 * (`GET /api/v1/datasets/:name` - see src/observe/routes/datasets.ts). One
 * fetch returns the dataset's examples oldest-first, capped at
 * {@link EVAL_MAX_EXAMPLES} so a huge regression set cannot make a publish
 * gate run forever.
 *
 * The daemon answers `{ dataset, examples, total, limit, offset }` where an
 * example is `{ example_id, input, expected, ... }` and `input`/`expected`
 * are already-parsed JSON values (the daemon JSON.parses its stored strings
 * on the way out). This client flattens each row to the gate runner's
 * `{ exampleId, input, expected }` shape: `input` becomes the prompt text
 * sent to the candidate run, `expected` the reference answer the judge
 * compares against (null when the dataset has none).
 */
import { daemonHeaders, observeTarget } from '../observeProxy';

/** The most examples one eval gate set runs (the daemon's `limit` cap for the fetch). */
export const EVAL_MAX_EXAMPLES = 50;

const DAEMON_TIMEOUT_MS = 8000;

/** One dataset example as the gate runner consumes it. */
export interface DatasetExample {
  exampleId: string;
  /** The run input, as prompt text. */
  input: string;
  /** The reference answer for the judge, or null when the example has none. */
  expected: string | null;
}

export type DatasetExamples =
  | { ok: true; examples: DatasetExample[] }
  | { ok: false; error: string };

export interface FetchDatasetOptions {
  /** The fetch daemon calls go through (tests). */
  fetch?: typeof fetch;
  /** Row cap; defaults to {@link EVAL_MAX_EXAMPLES}. */
  limit?: number;
}

/** A daemon example row (`ExampleRow` on the wire): `input`/`expected` are parsed JSON. */
interface DaemonExample {
  example_id?: unknown;
  input?: unknown;
  expected?: unknown;
}

/** `raw` as prompt/expected text: a JSON string holding text or `{ input }`, else its JSON. */
function asText(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'string') return parsed;
      if (typeof parsed === 'object' && parsed !== null && typeof (parsed as { input?: unknown }).input === 'string') {
        return (parsed as { input: string }).input;
      }
      return JSON.stringify(parsed);
    } catch {
      return raw;
    }
  }
  if (typeof raw === 'object' && raw !== null && typeof (raw as { input?: unknown }).input === 'string') {
    return (raw as { input: string }).input;
  }
  return JSON.stringify(raw);
}

/** One daemon row → the gate shape; rows without a usable id or input are skipped. */
function toExample(row: DaemonExample): DatasetExample | undefined {
  if (typeof row.example_id !== 'string' || row.example_id === '') return undefined;
  const input = asText(row.input);
  if (input === null) return undefined;
  return { exampleId: row.example_id, input, expected: asText(row.expected) };
}

/**
 * `GET <observeTarget>/api/v1/datasets/<name>?limit=<limit>` and the
 * examples it serves. `404` → `Dataset '<name>' not found`; a fetch that
 * throws or answers non-2xx → `Observe daemon unreachable`; an answer
 * without an examples array → the same unreachable error (the daemon is
 * not speaking the read API this client expects).
 */
export async function fetchDatasetExamples(name: string, options: FetchDatasetOptions = {}): Promise<DatasetExamples> {
  const fetchFn = options.fetch ?? fetch;
  const limit = options.limit ?? EVAL_MAX_EXAMPLES;
  const url = `${observeTarget()}/api/v1/datasets/${encodeURIComponent(name)}?limit=${limit}`;
  let response: globalThis.Response;
  try {
    response = await fetchFn(url, {
      headers: daemonHeaders(false),
      signal: AbortSignal.timeout(DAEMON_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, error: 'Observe daemon unreachable' };
  }
  if (response.status === 404) return { ok: false, error: `Dataset '${name}' not found` };
  if (!response.ok) return { ok: false, error: 'Observe daemon unreachable' };
  const body = (await response.json().catch(() => undefined)) as { examples?: unknown } | undefined;
  if (!Array.isArray(body?.examples)) return { ok: false, error: 'Observe daemon unreachable' };
  const examples = (body.examples as DaemonExample[])
    .map(toExample)
    .filter((entry): entry is DatasetExample => entry !== undefined)
    .slice(0, limit);
  return { ok: true, examples };
}
