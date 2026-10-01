import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { z } from 'zod';
import * as otelApi from '@opentelemetry/api';
import type { Tracer, Span as OtelSpan, Context, Meter } from '@opentelemetry/api';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { AggregationTemporality, InMemoryMetricExporter, MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { createOtelTraceExporter } from './otel';
import { AgentExecutor } from './AgentExecutor';
import { Span, TraceExporter } from './tracing';
import { ToolRegistry, defineTool } from '../tools';
import { AgentBuilder } from '../core';
import { AgentType } from '../types';
import { mockModel } from '../testing';

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

describe('createOtelTraceExporter GenAI metrics (LOU-D48)', () => {
  interface Recorded {
    name: string;
    value: number;
    attributes: Record<string, unknown>;
  }
  interface Instrument {
    name: string;
    options: { unit?: string; advice?: { explicitBucketBoundaries?: number[] } };
  }

  /** A minimal recording Meter: every histogram record lands in `records`. */
  function makeRecordingMeter() {
    const records: Recorded[] = [];
    const instruments: Instrument[] = [];
    const meter = {
      createHistogram: (name: string, options: Instrument['options']) => {
        instruments.push({ name, options });
        return { record: (value: number, attributes: Record<string, unknown> = {}) => records.push({ name, value, attributes }) };
      },
    } as unknown as Meter;
    return { meter, records, instruments };
  }

  const weather = defineTool({
    name: 'get_weather',
    description: 'Get the weather for a city',
    input: z.object({ city: z.string() }),
    execute: async ({ city }) => ({ city, tempC: 21 }),
  });

  /** One run with a priced model and one tool call, exported through `exporter`. */
  async function runPricedAgent(exporter: TraceExporter) {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(weather);
    const agent = {
      ...AgentBuilder.create()
        .setType(AgentType.SmartAssistant)
        .setName('Weather Bot')
        .addTool('get_weather', { tool: 'get_weather', options: {} })
        .build(),
      id: 'agent-1',
      settings: { model: 'gpt-4o-mini' },
    };
    const provider = mockModel([
      { toolCalls: [{ name: 'get_weather', args: { city: 'Paris' } }], usage: { inputTokens: 10, outputTokens: 5 } },
      { text: 'It is 21C.', usage: { inputTokens: 20, outputTokens: 7 } },
    ]);
    await AgentExecutor.execute({ agent, input: 'Weather?', provider, toolRegistry, exporter });
    return provider;
  }

  it('records token usage and duration histograms for each model call of a run', async () => {
    const fake = makeRecordingMeter();
    const provider = await runPricedAgent(createOtelTraceExporter({ tracer: makeFakeTracer().tracer, meter: fake.meter }));

    expect(fake.instruments).toEqual([
      expect.objectContaining({ name: 'gen_ai.client.token.usage', options: expect.objectContaining({ unit: '{token}' }) }),
      expect.objectContaining({ name: 'gen_ai.client.operation.duration', options: expect.objectContaining({ unit: 's' }) }),
    ]);
    expect(fake.instruments[0].options.advice?.explicitBucketBoundaries?.[0]).toBe(1);
    expect(fake.instruments[1].options.advice?.explicitBucketBoundaries?.[0]).toBe(0.01);

    const chat = { 'gen_ai.operation.name': 'chat', 'gen_ai.provider.name': provider.name, 'gen_ai.request.model': 'gpt-4o-mini' };
    const tokens = fake.records.filter((r) => r.name === 'gen_ai.client.token.usage');
    expect(tokens.map((r) => [r.value, r.attributes['gen_ai.token.type']])).toEqual([
      [10, 'input'],
      [5, 'output'],
      [20, 'input'],
      [7, 'output'],
    ]);
    for (const record of tokens) expect(record.attributes).toMatchObject(chat);

    const durations = fake.records.filter((r) => r.name === 'gen_ai.client.operation.duration');
    // two model calls and one tool call, in the order the spans ended
    expect(durations.map((r) => r.attributes['gen_ai.operation.name'])).toEqual(['chat', 'execute_tool', 'chat']);
    expect(durations[0].attributes).toMatchObject(chat);
    expect(durations[1].attributes).toEqual({ 'gen_ai.operation.name': 'execute_tool' });
    for (const record of durations) {
      expect(record.value).toBeGreaterThanOrEqual(0);
      expect(record.attributes).not.toHaveProperty('gen_ai.token.type');
    }
  });

  it('records gen_ai.response.model and error.type when the spans have them', () => {
    const fake = makeRecordingMeter();
    const exporter = createOtelTraceExporter({ tracer: makeFakeTracer().tracer, meter: fake.meter });
    const attributes = { 'gen_ai.operation.name': 'chat', 'gen_ai.response.model': 'gpt-4o-mini-2024', 'error.type': 'Error' };
    exporter.onSpanStart(makeSpan({ id: 'c', attributes }));
    exporter.onSpanEnd(makeSpan({ id: 'c', attributes, startTime: 1000, endTime: 3500 }));

    expect(fake.records).toEqual([
      { name: 'gen_ai.client.operation.duration', value: 2.5, attributes },
    ]);
  });

  it('records nothing for non-model, non-tool spans, and no tokens when none were reported', () => {
    const fake = makeRecordingMeter();
    const exporter = createOtelTraceExporter({ tracer: makeFakeTracer().tracer, meter: fake.meter });
    exporter.onSpanStart(makeSpan({ id: 'r', attributes: { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.usage.input_tokens': 3 } }));
    exporter.onSpanEnd(makeSpan({ id: 'r', endTime: 2000, attributes: { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.usage.input_tokens': 3 } }));
    exporter.onSpanStart(makeSpan({ id: 'x', attributes: {} }));
    exporter.onSpanEnd(makeSpan({ id: 'x', endTime: 2000, attributes: {} }));
    exporter.onSpanStart(makeSpan({ id: 'c', attributes: { 'gen_ai.operation.name': 'chat' } }));
    exporter.onSpanEnd(makeSpan({ id: 'c', endTime: 2000, attributes: { 'gen_ai.operation.name': 'chat' } }));

    expect(fake.records.map((r) => r.name)).toEqual(['gen_ai.client.operation.duration']);
  });

  it('creates no instruments when metrics is false', async () => {
    const fake = makeRecordingMeter();
    await runPricedAgent(createOtelTraceExporter({ tracer: makeFakeTracer().tracer, meter: fake.meter, metrics: false }));
    expect(fake.instruments).toEqual([]);
    expect(fake.records).toEqual([]);
  });

  describe('with the global MeterProvider', () => {
    afterEach(() => {
      otelApi.metrics.disable();
    });

    it('resolves the meter via metrics.getMeter(tracerName, tracerVersion) by default', async () => {
      const fake = makeRecordingMeter();
      const getMeter = vi.fn(() => fake.meter);
      otelApi.metrics.setGlobalMeterProvider({ getMeter });

      await runPricedAgent(createOtelTraceExporter({ tracer: makeFakeTracer().tracer, tracerName: 'my-agent', tracerVersion: '1.2.3' }));

      expect(getMeter).toHaveBeenCalledWith('my-agent', '1.2.3', undefined);
      expect(fake.records.some((r) => r.name === 'gen_ai.client.token.usage')).toBe(true);
    });

    it('records into a real SDK MeterProvider', async () => {
      const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
      const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 });
      const meterProvider = new MeterProvider({ readers: [reader] });
      otelApi.metrics.setGlobalMeterProvider(meterProvider);

      await runPricedAgent(createOtelTraceExporter({ tracer: makeFakeTracer().tracer }));

      await reader.forceFlush();
      const collected = exporter.getMetrics().flatMap((rm) => rm.scopeMetrics.flatMap((scope) => scope.metrics));
      const byName = Object.fromEntries(collected.map((m) => [m.descriptor.name, m]));
      expect(byName['gen_ai.client.token.usage'].descriptor.unit).toBe('{token}');
      expect(byName['gen_ai.client.operation.duration'].descriptor.unit).toBe('s');

      const sums = (byName['gen_ai.client.token.usage'].dataPoints as Array<{ attributes: Record<string, unknown>; value: { sum?: number; count: number } }>)
        .map((p) => [p.attributes['gen_ai.token.type'], p.value.sum, p.value.count]);
      expect(sums).toEqual(expect.arrayContaining([['input', 30, 2], ['output', 12, 2]]));
      await meterProvider.shutdown();
    });
  });
});

describe('optional peer', () => {
  it('only the /otel entry imports @opentelemetry/api, so the main package works without it', () => {
    const root = join(__dirname, '..');
    const importers: string[] = [];
    const visit = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) visit(path);
        else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
          if (/from\s+['"]@opentelemetry\//.test(readFileSync(path, 'utf8'))) importers.push(relative(root, path));
        }
      }
    };
    visit(root);
    expect(importers).toEqual([join('execution', 'otel.ts')]);
  });
});
