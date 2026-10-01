import { describe, it, expect } from 'vitest';
import type { Cassette } from '../testing/cassette';
import { diffTrajectories, trajectoryOf, type Trajectory } from './drift';

type Entry = Cassette['entries'][number];

const request: Entry['request'] = { model: 'm', messages: [], tools: [], temperature: null, maxTokens: null };

function toolStep(calls: Array<[string, string]>, totalTokens = 10): Entry {
  return {
    kind: 'generate',
    request,
    response: {
      text: '',
      finishReason: 'tool_calls',
      usage: { promptTokens: totalTokens, completionTokens: 0, totalTokens },
      toolCalls: calls.map(([name, args], i) => ({ id: `c${i}`, type: 'function', function: { name, arguments: args } })),
    },
  };
}

const stop = (totalTokens = 5): Entry => ({
  kind: 'generate',
  request,
  response: { text: 'done', finishReason: 'stop', usage: { promptTokens: totalTokens, completionTokens: 0, totalTokens } },
});

describe('trajectoryOf', () => {
  it('reads ordered tool calls with key-sorted args, steps, finish reason and tokens', () => {
    const trajectory = trajectoryOf({ entries: [toolStep([['lookup', '{"b":2,"a":1}'], ['refund', 'not json']]), stop()] });
    expect(trajectory).toEqual({
      tools: [
        { name: 'lookup', args: '{"a":1,"b":2}' },
        { name: 'refund', args: 'not json' },
      ],
      steps: 2,
      finishReason: 'stop',
      totalTokens: 15,
    });
  });

  it('uses the error name when the last call failed and omits tokens without usage', () => {
    const trajectory = trajectoryOf({ entries: [{ kind: 'generate', request, error: { name: 'RateLimitError', message: 'slow down' } }] });
    expect(trajectory).toEqual({ tools: [], steps: 1, finishReason: 'RateLimitError' });
  });
});

describe('diffTrajectories', () => {
  const base: Trajectory = trajectoryOf({ entries: [toolStep([['lookup', '{"id":"42"}'], ['refund', '{"id":"42"}']]), stop()] });

  it('reports no drift for the same trajectory, whatever the args key order', () => {
    const same = trajectoryOf({ entries: [toolStep([['lookup', '{ "id": "42" }'], ['refund', '{"id":"42"}']]), stop()] });
    expect(diffTrajectories(base, same)).toEqual([]);
  });

  it('reports tool order drift (and not per-call args drift on top of it)', () => {
    const swapped = trajectoryOf({ entries: [toolStep([['refund', '{"id":"42"}'], ['lookup', '{"id":"42"}']]), stop()] });
    expect(diffTrajectories(base, swapped)).toEqual([{ field: 'tools', committed: 'lookup > refund', current: 'refund > lookup' }]);
  });

  it('reports args drift per call', () => {
    const changed = trajectoryOf({ entries: [toolStep([['lookup', '{"id":"43"}'], ['refund', '{"id":"42"}']]), stop()] });
    expect(diffTrajectories(base, changed)).toEqual([{ field: 'args', committed: 'lookup {"id":"42"}', current: 'lookup {"id":"43"}' }]);
  });

  it('reports step count and finish reason drift', () => {
    const cut = trajectoryOf({ entries: [toolStep([['lookup', '{"id":"42"}'], ['refund', '{"id":"42"}']])] });
    expect(diffTrajectories(base, cut)).toEqual([
      { field: 'steps', committed: '2', current: '1' },
      { field: 'finishReason', committed: 'stop', current: 'tool_calls' },
    ]);
  });

  it('ignores token (cost) drift unless asked for it', () => {
    const pricier = trajectoryOf({ entries: [toolStep([['lookup', '{"id":"42"}'], ['refund', '{"id":"42"}']], 900), stop()] });
    expect(diffTrajectories(base, pricier)).toEqual([]);
    expect(diffTrajectories(base, pricier, { usage: true })).toEqual([{ field: 'tokens', committed: '15', current: '905' }]);
  });
});
