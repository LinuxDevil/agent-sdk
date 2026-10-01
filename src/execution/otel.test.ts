import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Tracer, Span as OtelSpan, Context } from '@opentelemetry/api';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { createOtelTraceExporter } from './otel';
import { Span } from './tracing';

/**
 * A minimal fake OTel span that just records what was done to it, so
 * assertions can check exact call shapes without needing a real
 * TracerProvider/exporter backend.
 */
function makeFakeOtelSpan(name: string) {
  return {
    name,
    attributes: {} as Record<string, unknown>,
    ended: false,
    endTime: undefined as number | undefined,
    setAttribute(key: string, value: unknown) {
      this.attributes[key] = value;
      return this;
    },
    end(endTime?: number) {
      this.ended = true;
      this.endTime = endTime;
    },
  } as unknown as OtelSpan & {
    name: string;
    attributes: Record<string, unknown>;
    ended: boolean;
    endTime: number | undefined;
  };
}

function makeFakeTracer() {
  const startedSpans: Array<{
    name: string;
    options: unknown;
    parentContext: unknown;
    span: ReturnType<typeof makeFakeOtelSpan>;
  }> = [];

  const tracer: Tracer = {
    startSpan: vi.fn((name: string, options: unknown, parentContext?: Context) => {
      const span = makeFakeOtelSpan(name);
      startedSpans.push({ name, options, parentContext, span });
      return span;
    }),
    startActiveSpan: vi.fn() as unknown as Tracer['startActiveSpan'],
  };

  return { tracer, startedSpans };
}

function makeSpan(overrides: Partial<Span> = {}): Span {
  return {
    id: 'span-1',
    name: 'agent.run',
    attributes: { model: 'gpt-4' },
    startTime: 1000,
    ...overrides,
  };
}

describe('createOtelTraceExporter', () => {
  let fake: ReturnType<typeof makeFakeTracer>;

  beforeEach(() => {
    fake = makeFakeTracer();
  });

  it('starts an OTel span with the SDK span name and startTime on onSpanStart', () => {
    const exporter = createOtelTraceExporter({ tracer: fake.tracer });
    const span = makeSpan({ id: 's1', name: 'agent.run', startTime: 1234, attributes: { model: 'gpt-4' } });

    exporter.onSpanStart(span);

    expect(fake.tracer.startSpan).toHaveBeenCalledTimes(1);
    const [name, options] = (fake.tracer.startSpan as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(name).toBe('agent.run');
    expect(options).toMatchObject({ startTime: 1234 });
    expect(fake.startedSpans[0].span.attributes).toEqual({ model: 'gpt-4' });
  });

  it('translates primitive attributes with setAttribute and stringifies non-primitives', () => {
    const exporter = createOtelTraceExporter({ tracer: fake.tracer });
    const span = makeSpan({
      id: 's1',
      attributes: {
        model: 'gpt-4',
        tokens: 42,
        cached: true,
        args: { city: 'Cairo' },
        skip: undefined,
      },
    });

    exporter.onSpanStart(span);

    expect(fake.startedSpans[0].span.attributes).toEqual({
      model: 'gpt-4',
      tokens: 42,
      cached: true,
      args: JSON.stringify({ city: 'Cairo' }),
    });
  });

  it('ends the matching OTel span with the SDK span endTime and merged attributes on onSpanEnd', () => {
    const exporter = createOtelTraceExporter({ tracer: fake.tracer });
    const span = makeSpan({ id: 's1', attributes: { model: 'gpt-4' } });
    exporter.onSpanStart(span);

    const finished: Span = { ...span, endTime: 2000, attributes: { model: 'gpt-4', result: 'ok' } };
    exporter.onSpanEnd(finished);

    const otelSpan = fake.startedSpans[0].span;
    expect(otelSpan.ended).toBe(true);
    expect(otelSpan.endTime).toBe(2000);
    expect(otelSpan.attributes).toEqual({ model: 'gpt-4', result: 'ok' });
  });

  it('is a no-op on onSpanEnd for a span id that was never started', () => {
    const exporter = createOtelTraceExporter({ tracer: fake.tracer });
    expect(() =>
      exporter.onSpanEnd(makeSpan({ id: 'unknown', endTime: 999 }))
    ).not.toThrow();
  });

  it('starts a child span using the parent OTel context when parentId matches a started span', () => {
    const exporter = createOtelTraceExporter({ tracer: fake.tracer });
    const parent = makeSpan({ id: 'parent', name: 'agent.run' });
    exporter.onSpanStart(parent);

    const child = makeSpan({ id: 'child', name: 'llm.generate', parentId: 'parent', startTime: 1100 });
    exporter.onSpanStart(child);

    expect(fake.tracer.startSpan).toHaveBeenCalledTimes(2);
    // The child's startSpan call should receive a parentContext distinct
    // from the ambient/default context used for the root span - i.e. it
    // was threaded from the parent's own context, not context.active().
    const rootParentContext = fake.startedSpans[0].parentContext;
    const childParentContext = fake.startedSpans[1].parentContext;
    expect(childParentContext).not.toBe(rootParentContext);
  });

  it('defaults to a tracer resolved via trace.getTracer when no tracer option is passed', async () => {
    const otelApi = await import('@opentelemetry/api');
    const getTracerSpy = vi.spyOn(otelApi.trace, 'getTracer');

    createOtelTraceExporter({ tracerName: 'my-agent', tracerVersion: '1.2.3' });

    expect(getTracerSpy).toHaveBeenCalledWith('my-agent', '1.2.3');
    getTracerSpy.mockRestore();
  });
});

describe('createOtelTraceExporter kind, status and array attributes (LOU-D9)', () => {
  it('maps span kind client/internal to the OTel SpanKind on start', () => {
    const fake = makeFakeTracer();
    const exporter = createOtelTraceExporter({ tracer: fake.tracer });
    exporter.onSpanStart(makeSpan({ id: 'c', kind: 'client' }));
    exporter.onSpanStart(makeSpan({ id: 'i' }));

    const calls = (fake.tracer.startSpan as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][1]).toMatchObject({ kind: SpanKind.CLIENT });
    expect(calls[1][1]).toMatchObject({ kind: SpanKind.INTERNAL });
  });

  it('sets an ERROR status on end when the SDK span failed, and none otherwise', () => {
    const fake = makeFakeTracer();
    const exporter = createOtelTraceExporter({ tracer: fake.tracer });
    const bad = vi.fn();
    const good = vi.fn();
    exporter.onSpanStart(makeSpan({ id: 'bad' }));
    exporter.onSpanStart(makeSpan({ id: 'good' }));
    (fake.startedSpans[0].span as { setStatus: unknown }).setStatus = bad;
    (fake.startedSpans[1].span as { setStatus: unknown }).setStatus = good;

    exporter.onSpanEnd(makeSpan({ id: 'bad', endTime: 5, status: { code: 'error', message: 'boom' } }));
    exporter.onSpanEnd(makeSpan({ id: 'good', endTime: 5 }));

    expect(bad).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR, message: 'boom' });
    expect(good).not.toHaveBeenCalled();
  });

  it('passes homogeneous primitive arrays through and stringifies other arrays', () => {
    const fake = makeFakeTracer();
    const exporter = createOtelTraceExporter({ tracer: fake.tracer });
    exporter.onSpanStart(
      makeSpan({ attributes: { 'gen_ai.response.finish_reasons': ['stop'], mixed: ['a', 1], objs: [{ a: 1 }] } })
    );
    expect(fake.startedSpans[0].span.attributes).toEqual({
      'gen_ai.response.finish_reasons': ['stop'],
      mixed: JSON.stringify(['a', 1]),
      objs: JSON.stringify([{ a: 1 }]),
    });
  });
});
