import { describe, it, expect, vi } from 'vitest';
import { withSpan, Span, TraceExporter } from './tracing';

function createSpyExporter() {
  const starts: Span[] = [];
  const ends: Span[] = [];
  const exporter: TraceExporter = {
    onSpanStart: vi.fn((span: Span) => {
      starts.push({ ...span });
    }),
    onSpanEnd: vi.fn((span: Span) => {
      ends.push({ ...span });
    }),
  };
  return { exporter, starts, ends };
}

describe('withSpan', () => {
  it('calls onSpanStart before fn and onSpanEnd after, with endTime >= startTime', async () => {
    const { exporter, starts, ends } = createSpyExporter();
    const order: string[] = [];

    const result = await withSpan(exporter, 'test.span', { foo: 'bar' }, async () => {
      order.push('fn');
      return 42;
    });

    expect(result).toBe(42);
    expect(order).toEqual(['fn']);
    expect(exporter.onSpanStart).toHaveBeenCalledTimes(1);
    expect(exporter.onSpanEnd).toHaveBeenCalledTimes(1);
    expect(starts[0].name).toBe('test.span');
    expect(starts[0].attributes).toEqual({ foo: 'bar' });
    expect(ends[0].endTime).toBeGreaterThanOrEqual(ends[0].startTime);
  });

  it('still calls onSpanEnd with an error attribute when fn throws, and rethrows the original error', async () => {
    const { exporter, ends } = createSpyExporter();
    const boom = new Error('boom');

    await expect(
      withSpan(exporter, 'test.span', {}, async () => {
        throw boom;
      })
    ).rejects.toBe(boom);

    expect(exporter.onSpanEnd).toHaveBeenCalledTimes(1);
    expect(ends[0].attributes.error).toBe('boom');
  });

  it('does not throw when no exporter is supplied', async () => {
    const result = await withSpan(undefined, 'test.span', {}, async () => 'ok');
    expect(result).toBe('ok');
  });

  it('does not throw when no exporter is supplied and fn throws', async () => {
    await expect(
      withSpan(undefined, 'test.span', {}, async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
  });

  it('passes the generated span (with an id) to fn so callers can thread parentId', async () => {
    const { exporter } = createSpyExporter();
    let seenId: string | undefined;

    await withSpan(exporter, 'parent', {}, async (span) => {
      seenId = span.id;

      await withSpan(exporter, 'child', {}, async () => undefined, span.id);
    });

    expect(seenId).toBeTruthy();
    expect(exporter.onSpanStart).toHaveBeenCalledTimes(2);
  });
});

describe('withSpan kind and error status (LOU-D9)', () => {
  it('records the span kind when given and leaves it unset otherwise', async () => {
    const { exporter, starts } = createSpyExporter();
    await withSpan(exporter, 'a', {}, async () => 1, undefined, 'client');
    await withSpan(exporter, 'b', {}, async () => 2);
    expect(starts[0].kind).toBe('client');
    expect(starts[1].kind).toBeUndefined();
  });

  it('sets error.type (the error name) and an error status when fn throws', async () => {
    const { exporter, ends } = createSpyExporter();
    await expect(
      withSpan(exporter, 's', {}, async () => {
        throw new TypeError('bad');
      })
    ).rejects.toThrow('bad');
    expect(ends[0].attributes).toMatchObject({ error: 'bad', 'error.type': 'TypeError' });
    expect(ends[0].status).toEqual({ code: 'error', message: 'bad' });
  });

  it('uses _OTHER as error.type when a non-Error is thrown', async () => {
    const { exporter, ends } = createSpyExporter();
    await expect(
      withSpan(exporter, 's', {}, async () => {
        throw 'plain string';
      })
    ).rejects.toBe('plain string');
    expect(ends[0].attributes['error.type']).toBe('_OTHER');
    expect(ends[0].status).toEqual({ code: 'error', message: 'plain string' });
  });
});
