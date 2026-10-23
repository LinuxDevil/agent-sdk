/** The ingest envelope is the single contract shared by reporter and daemon; these pin its acceptance and rejection edges. */
import { describe, expect, it } from 'vitest';
import { parseIngestEnvelope, OBSERVE_MAX_BATCH_EVENTS } from './envelope';

const observation = {
  obs_id: 'obs-1',
  trace_id: 'trace-1',
  kind: 'span',
  name: 'invoke_agent a',
  start: 1000,
  end: 1100,
};

describe('parseIngestEnvelope', () => {
  it('accepts a well-formed batch of every event type', () => {
    const result = parseIngestEnvelope({
      batch: [
        { type: 'agent.heartbeat', data: { agent_id: 'a1', project: 'p' } },
        { type: 'agent.deregister', data: { agent_id: 'a1' } },
        { type: 'observation', data: observation },
        { type: 'prompt_use', data: { obs_id: 'obs-1', prompt_id: 'p1', version: 2 } },
        { type: 'score', data: { score_id: 's1', trace_id: 'trace-1', name: 'eval/x', value: 1, source: 'judge' } },
      ],
    });
    expect(result.ok).toBe(true);
  });

  it('accepts an empty batch', () => {
    expect(parseIngestEnvelope({ batch: [] }).ok).toBe(true);
  });

  it('rejects a body that is not an envelope', () => {
    for (const body of [undefined, null, {}, { batch: {} }, { batch: [1] }, '[]']) {
      expect(parseIngestEnvelope(body).ok, JSON.stringify(body)).toBe(false);
    }
  });

  it('rejects an unknown event type', () => {
    const result = parseIngestEnvelope({ batch: [{ type: 'hub.entry', data: {} }] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.join(' ')).toContain('batch');
  });

  it('rejects an observation without obs_id/trace_id/kind', () => {
    for (const data of [{ trace_id: 't', kind: 'span', start: 1 }, { obs_id: 'o', kind: 'span', start: 1 }, { obs_id: 'o', trace_id: 't', start: 1 }, { obs_id: 'o', trace_id: 't', kind: 'span' }]) {
      const result = parseIngestEnvelope({ batch: [{ type: 'observation', data }] });
      expect(result.ok, JSON.stringify(data)).toBe(false);
    }
  });

  it('rejects a bad observation kind and a bad score source', () => {
    expect(parseIngestEnvelope({ batch: [{ type: 'observation', data: { ...observation, kind: 'trace' } }] }).ok).toBe(false);
    expect(
      parseIngestEnvelope({ batch: [{ type: 'score', data: { score_id: 's', trace_id: 't', name: 'n', source: 'auto' } }] }).ok
    ).toBe(false);
  });

  it('rejects a heartbeat without agent_id', () => {
    expect(parseIngestEnvelope({ batch: [{ type: 'agent.heartbeat', data: { project: 'p' } }] }).ok).toBe(false);
  });

  it('rejects a batch over the event cap', () => {
    const batch = Array.from({ length: OBSERVE_MAX_BATCH_EVENTS + 1 }, (_, i) => ({
      type: 'agent.heartbeat' as const,
      data: { agent_id: `a${i}` },
    }));
    expect(parseIngestEnvelope({ batch }).ok).toBe(false);
  });

  it('keeps optional usage and cost fields', () => {
    const result = parseIngestEnvelope({
      batch: [
        {
          type: 'observation',
          data: {
            ...observation,
            usage_input_tokens: 10,
            usage_output_tokens: 5,
            usage_cached_tokens: 2,
            usage_reasoning_tokens: 1,
            cost_usd: 0.001,
            cost_partial: true,
            usage_estimated: true,
          },
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const event = result.envelope.batch[0];
      expect(event.type === 'observation' && event.data.cost_partial).toBe(true);
    }
  });
});
