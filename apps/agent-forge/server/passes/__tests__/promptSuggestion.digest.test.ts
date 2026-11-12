import { describe, it, expect } from 'vitest';
import type { ObservationRow } from 'lousho/traces';
import { buildFrictionDigest } from '../promptSuggestion';

/** A minimal ObservationRow; every field the digest does not read defaults sanely. */
function obs(over: Partial<ObservationRow> & { obs_id: string }): ObservationRow {
  return {
    trace_id: 't1',
    session_id: null,
    agent_id: 'a1',
    parent_obs_id: null,
    kind: 'span',
    name: null,
    start: 0,
    end: 1,
    status: 'ok',
    input: null,
    output: null,
    model: null,
    usage_input_tokens: null,
    usage_output_tokens: null,
    usage_cached_tokens: null,
    usage_reasoning_tokens: null,
    cost_usd: null,
    cost_partial: null,
    usage_estimated: null,
    truncated: false,
    attrs: null,
    ...over,
  };
}

const tool = (id: string, name: string, over: Partial<ObservationRow> = {}) =>
  obs({ obs_id: id, kind: 'tool', name, ...over });

describe('buildFrictionDigest', () => {
  it('numbers tool calls, marks repeats and failures, and lists non-tool errors', () => {
    const observations = [
      obs({ obs_id: 'root', kind: 'agent', name: 'invoke_agent ops', parent_obs_id: null, output: 'All done.' }),
      tool('o1', 'fetch_page', { input: '{"url":"a"}', output: 'page a', status: 'error' }),
      tool('o2', 'fetch_page', { input: '{"url":"a"}', status: 'error' }),
      tool('o3', 'fetch_page', { input: '{"url":"a"}', status: 'error' }),
      tool('o4', 'search', { input: '{"q":"x"}', output: 'results' }),
      obs({ obs_id: 'e1', kind: 'generation', name: 'llm', status: 'error', output: 'rate limited' }),
    ];
    const digest = buildFrictionDigest(observations);
    expect(digest.counts).toEqual({ toolCalls: 4, failedToolCalls: 3, repeatedCalls: 2, errors: 4 });
    expect(digest.text).toContain('Run summary: 4 tool calls, 3 failed, 2 repeated, 4 errors.');
    expect(digest.text).toContain('#1 fetch_page error args={"url":"a"} → page a');
    // o2/o3 repeat o1's name+input.
    expect(digest.text).toContain('#2 fetch_page error args={"url":"a"} → (none) (repeat of #1)');
    expect(digest.text).toContain('#3 fetch_page error args={"url":"a"} → (none) (repeat of #1)');
    expect(digest.text).toContain('#4 search ok args={"q":"x"} → results');
    expect(digest.text).toContain('error in generation llm: rate limited');
    expect(digest.text).toContain('Final answer:\nAll done.');
  });

  it('uses attrs.error when a tool observation has no output', () => {
    const digest = buildFrictionDigest([
      tool('o1', 'send_email', { status: 'error', attrs: { error: 'smtp refused' } }),
    ]);
    expect(digest.text).toContain('#1 send_email error args=(none) → smtp refused');
  });

  it('orders observations by start regardless of input order', () => {
    const digest = buildFrictionDigest([
      tool('late', 'b_tool', { start: 20, output: 'b' }),
      tool('early', 'a_tool', { start: 10, output: 'a' }),
    ]);
    expect(digest.text.indexOf('#1 a_tool')).toBeLessThan(digest.text.indexOf('#2 b_tool'));
  });

  it('writes (none) sections for an empty trace and caps the digest at 24 000 chars', () => {
    const empty = buildFrictionDigest([]);
    expect(empty.text).toContain('Run summary: 0 tool calls, 0 failed, 0 repeated, 0 errors.');
    expect(empty.text).toContain('Errors:\n(none)');
    expect(empty.text).toContain('Final answer:\n(none)');

    const many = Array.from({ length: 400 }, (_, i) =>
      tool(`o${i}`, `tool_${i}`, { input: 'x'.repeat(400), output: 'y'.repeat(400) })
    );
    const capped = buildFrictionDigest(many);
    expect(capped.text.length).toBeLessThanOrEqual(24_000);
    expect(capped.text).toContain('more tool calls not shown');
    expect(capped.counts.toolCalls).toBe(400);
  });
});
