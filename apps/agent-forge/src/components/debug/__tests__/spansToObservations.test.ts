import { describe, it, expect } from 'vitest';
import { spansToObservations } from '../spansToObservations';
import type { SpanEvent } from '../../../../shared/wireTypes';

// One run as the SDK reports it: an agent root, a model call and a failed tool call still open.
const SPANS: SpanEvent[] = [
  {
    id: 'root',
    name: 'invoke_agent weather',
    startTime: 1000,
    endTime: 2650,
    kind: 'internal',
    attributes: { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.input.messages': 'hi', 'lousho.cost_usd': 0.002 },
  },
  {
    id: 'c1',
    parentId: 'root',
    name: 'chat gpt-4o-mini',
    startTime: 1000,
    endTime: 1900,
    kind: 'client',
    status: { code: 'ok' },
    attributes: {
      'gen_ai.operation.name': 'chat',
      'gen_ai.request.model': 'gpt-4o-mini',
      'gen_ai.response.model': 'gpt-4o-mini-2024',
      'gen_ai.usage.input_tokens': 159,
      'gen_ai.usage.output_tokens': 32,
      'gen_ai.usage.cached_input_tokens': 10,
      'lousho.usage.reasoning_tokens': 4,
      'lousho.usage.estimated': true,
      'lousho.cost_usd': 0.000043,
      'gen_ai.input.messages': [{ role: 'user', content: 'hi' }],
      'gen_ai.output.messages': '[{"role":"assistant","content":"hello"}]',
    },
  },
  {
    id: 't1',
    parentId: 'c1',
    name: 'execute_tool get_weather',
    startTime: 1900,
    kind: 'internal',
    status: { code: 'error', message: 'boom' },
    attributes: { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.call.arguments': { city: 'Oslo' } },
  },
];

describe('spansToObservations', () => {
  const rows = spansToObservations(SPANS);

  it('keeps ids and parents, and names every row after its root span as the trace', () => {
    expect(rows.map((r) => [r.obs_id, r.parent_obs_id, r.trace_id])).toEqual([
      ['root', null, 'root'],
      ['c1', 'root', 'root'],
      ['t1', 'c1', 'root'],
    ]);
    expect(rows[0].name).toBe('invoke_agent weather');
  });

  it('maps the GenAI operation to the observation kind', () => {
    expect(rows.map((r) => r.kind)).toEqual(['span', 'generation', 'tool']);
    expect(spansToObservations([{ id: 'x', name: 'x', startTime: 0, attributes: {} }])[0].kind).toBe('span');
  });

  it('carries start/end, leaving an open span with end null and no status', () => {
    expect([rows[1].start, rows[1].end]).toEqual([1000, 1900]);
    expect(rows[2].end).toBeNull();
    expect(spansToObservations([{ id: 'x', name: 'x', startTime: 0, attributes: {} }])[0].status).toBeNull();
  });

  it('marks an ended span ok and a failed one error with its message in attrs.error', () => {
    expect(rows[0].status).toBe('ok');
    expect(rows[2].status).toBe('error');
    expect(rows[2].attrs).toEqual({ 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.call.arguments': { city: 'Oslo' }, error: 'boom' });
    expect(rows[1].attrs).toBe(SPANS[1].attributes);
  });

  it('reads model, usage and cost from the gen_ai / lousho attributes', () => {
    expect(rows[1]).toMatchObject({
      model: 'gpt-4o-mini-2024',
      usage_input_tokens: 159,
      usage_output_tokens: 32,
      usage_cached_tokens: 10,
      usage_reasoning_tokens: 4,
      usage_estimated: true,
      cost_usd: 0.000043,
    });
    expect(rows[0]).toMatchObject({ model: null, usage_input_tokens: null, usage_estimated: null, cost_usd: 0.002 });
  });

  it('takes input/output per operation, as JSON when not a string', () => {
    expect(rows[1].input).toBe('[{"role":"user","content":"hi"}]');
    expect(rows[1].output).toBe('[{"role":"assistant","content":"hello"}]');
    expect(rows[2].input).toBe('{"city":"Oslo"}');
    expect(rows[2].output).toBeNull();
    expect(rows[0].input).toBe('hi');
  });

  it('treats a span whose parent is missing as a root of its own trace', () => {
    const [orphan] = spansToObservations([{ id: 'o', parentId: 'gone', name: 'o', startTime: 0, attributes: {} }]);
    expect(orphan.trace_id).toBe('o');
    expect(orphan.parent_obs_id).toBe('gone');
  });
});
