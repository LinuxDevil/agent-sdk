import { describe, it, expect } from 'vitest';
import { APPROVAL_WAIT_SPAN_NAME, SdkAttr, type Span } from '@linuxdevil/lousho';
import { nodeStateFor } from '../nodeStates';

const NOW = new Date('2026-10-29T12:00:00.000Z');

function span(overrides: Partial<Span> = {}): Span {
  return {
    id: 'span-1',
    name: 'execute_tool current_date',
    attributes: { [SdkAttr.NODE_ID]: 'tool:current_date' },
    startTime: 1,
    ...overrides,
  };
}

describe('nodeStateFor', () => {
  it('returns undefined when the span carries no node id', () => {
    expect(nodeStateFor(span({ attributes: {} }), 'start', NOW)).toBeUndefined();
  });

  it('returns undefined when the node id attribute is an empty string', () => {
    expect(
      nodeStateFor(span({ attributes: { [SdkAttr.NODE_ID]: '' } }), 'start', NOW)
    ).toBeUndefined();
  });

  it('returns undefined when the node id attribute is not a string', () => {
    expect(
      nodeStateFor(span({ attributes: { [SdkAttr.NODE_ID]: 42 } }), 'start', NOW)
    ).toBeUndefined();
  });

  it('a span start yields state "running"', () => {
    expect(nodeStateFor(span(), 'start', NOW)).toEqual({
      nodeId: 'tool:current_date',
      state: 'running',
      spanId: 'span-1',
      at: NOW.toISOString(),
    });
  });

  it('an approval.wait span start yields state "waiting"', () => {
    const wait = span({
      name: `${APPROVAL_WAIT_SPAN_NAME} current_date`,
      attributes: {
        [SdkAttr.NODE_ID]: 'tool:current_date',
        [SdkAttr.APPROVAL_ID]: 'appr-1',
        [SdkAttr.APPROVAL_KIND]: 'tool',
      },
    });
    expect(nodeStateFor(wait, 'start', NOW)?.state).toBe('waiting');
  });

  it('a span end without an error status yields state "done"', () => {
    expect(nodeStateFor(span({ endTime: 2 }), 'end', NOW)?.state).toBe('done');
    expect(
      nodeStateFor(span({ endTime: 2, status: { code: 'ok' } }), 'end', NOW)?.state
    ).toBe('done');
  });

  it('a span end with an error status yields state "error"', () => {
    const failed = span({ endTime: 2, status: { code: 'error', message: 'boom' } });
    expect(nodeStateFor(failed, 'end', NOW)).toEqual({
      nodeId: 'tool:current_date',
      state: 'error',
      spanId: 'span-1',
      at: NOW.toISOString(),
    });
  });
});
