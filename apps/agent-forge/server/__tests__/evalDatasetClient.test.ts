import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchDatasetExamples } from '../evals/datasetClient';

const NAME = 'support-regressions';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function datasetWith(examples: unknown[]): Response {
  return jsonResponse({ dataset: { name: NAME }, examples, total: examples.length, limit: 50, offset: 0 });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('fetchDatasetExamples', () => {
  it('fetches the dataset with the daemon headers and example cap', async () => {
    const fetchFn = vi.fn(async () => datasetWith([]));
    await fetchDatasetExamples(NAME, { fetch: fetchFn as unknown as typeof fetch });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain(`/api/v1/datasets/${NAME}?limit=50`);
    expect((init.headers as Record<string, string>).accept).toBe('application/json');
  });

  it('honours a custom limit', async () => {
    const fetchFn = vi.fn(async () => datasetWith([]));
    await fetchDatasetExamples(NAME, { fetch: fetchFn as unknown as typeof fetch, limit: 10 });
    expect((fetchFn.mock.calls[0] as unknown as [string])[0]).toContain('limit=10');
  });

  it.each([
    ['a plain string', 'hello', 'hello'],
    ['a JSON string', '"hello there"', 'hello there'],
    ['an object with a string input', { input: 'do the thing' }, 'do the thing'],
    ['any other object', { question: 'q', context: 1 }, '{"question":"q","context":1}'],
    ['a number', 42, '42'],
  ])('maps input %s to prompt text', async (_label, input, expected) => {
    const fetchFn = vi.fn(async () => datasetWith([{ example_id: 'e1', input, expected: null }]));
    const result = await fetchDatasetExamples(NAME, { fetch: fetchFn as unknown as typeof fetch });
    expect(result).toEqual({ ok: true, examples: [{ exampleId: 'e1', input: expected, expected: null }] });
  });

  it('maps expected the same way and keeps null expected null', async () => {
    const fetchFn = vi.fn(async () =>
      datasetWith([
        { example_id: 'e1', input: 'in', expected: 'the answer' },
        { example_id: 'e2', input: 'in2', expected: { input: 'nested expected' } },
        { example_id: 'e3', input: 'in3', expected: null },
      ])
    );
    const result = await fetchDatasetExamples(NAME, { fetch: fetchFn as unknown as typeof fetch });
    expect(result.ok && result.examples.map((e) => e.expected)).toEqual(['the answer', 'nested expected', null]);
  });

  it('skips rows without an example_id or input', async () => {
    const fetchFn = vi.fn(async () =>
      datasetWith([
        { example_id: 'e1', input: 'ok' },
        { input: 'no id' },
        { example_id: 'e3' },
        { example_id: '', input: 'empty id' },
      ])
    );
    const result = await fetchDatasetExamples(NAME, { fetch: fetchFn as unknown as typeof fetch });
    expect(result.ok && result.examples).toHaveLength(1);
  });

  it('answers "not found" on a 404', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ error: 'nope' }, 404));
    const result = await fetchDatasetExamples('missing', { fetch: fetchFn as unknown as typeof fetch });
    expect(result).toEqual({ ok: false, error: "Dataset 'missing' not found" });
  });

  it('answers "unreachable" when the fetch throws', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const result = await fetchDatasetExamples(NAME, { fetch: fetchFn as unknown as typeof fetch });
    expect(result).toEqual({ ok: false, error: 'Observe daemon unreachable' });
  });

  it.each([500, 401])('answers "unreachable" on HTTP %i', async (status) => {
    const fetchFn = vi.fn(async () => jsonResponse({ error: 'x' }, status));
    const result = await fetchDatasetExamples(NAME, { fetch: fetchFn as unknown as typeof fetch });
    expect(result).toEqual({ ok: false, error: 'Observe daemon unreachable' });
  });

  it('answers "unreachable" when the body has no examples array', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ dataset: {} }));
    const result = await fetchDatasetExamples(NAME, { fetch: fetchFn as unknown as typeof fetch });
    expect(result).toEqual({ ok: false, error: 'Observe daemon unreachable' });
  });
});
