/**
 * otelTracingFromEnv() and the exporter wiring of the built server: the real
 * OTel SDK (@opentelemetry/sdk-trace-node, @opentelemetry/resources, both dev
 * dependencies) with an in-memory span exporter standing in for
 * @opentelemetry/exporter-trace-otlp-http, which is not installed here (the
 * real OTLP POST is covered by adapters/node-server-otel.test.ts with a stub).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-node';
import { createAgent } from '../createAgent';
import type { Span, TraceExporter } from '../execution/tracing';
import { mockModel } from '../testing';
import { agentWithOtelTracing, otelTracingFromEnv, otlpTracesEndpoint, withOtelTracing, type OtelTracing } from './otelTracing';

const OTLP_HTTP = '@opentelemetry/exporter-trace-otlp-http';

/** Loads the real OTel SDK packages, and `memory` as the OTLP exporter package. */
function loader(memory: InMemorySpanExporter) {
  const loaded: string[] = [];
  const load = async (name: string): Promise<unknown> => {
    loaded.push(name);
    // The provider's shutdown() shuts the exporter down, which would clear the in-memory one.
    if (name === OTLP_HTTP) return { OTLPTraceExporter: class { constructor() { return Object.assign(Object.create(memory), { shutdown: async () => {} }); } } };
    return import(name);
  };
  return { load, loaded };
}

const OTEL_VARS = ['OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT', 'OTEL_SERVICE_NAME', 'OTEL_RESOURCE_ATTRIBUTES'];

/** Sets exactly `vars` of the OTel variables (the OTel SDK reads process.env itself). */
function otelEnv(vars: Record<string, string>): void {
  for (const name of OTEL_VARS) vi.stubEnv(name, vars[name] ?? '');
}

afterEach(() => {
  vi.unstubAllEnvs();
});

const quiet = () => ({ log: vi.fn(), error: vi.fn() });

function recording(): TraceExporter & { ended: Span[] } {
  const ended: Span[] = [];
  return { ended, onSpanStart: () => {}, onSpanEnd: (span) => ended.push(span) };
}

describe('otelTracingFromEnv', () => {
  it('does nothing, and imports nothing, when no OTLP endpoint is set', async () => {
    const { load, loaded } = loader(new InMemorySpanExporter());
    otelEnv({});
    expect(await otelTracingFromEnv({ serviceName: 'a', load })).toBeUndefined();
    otelEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: '  ' });
    expect(await otelTracingFromEnv({ serviceName: 'a', load })).toBeUndefined();
    expect(loaded).toEqual([]);
  });

  it('exports the agent spans with OTEL_SERVICE_NAME as service.name', async () => {
    const memory = new InMemorySpanExporter();
    const log = quiet();
    otelEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://user:secret@collector:4318/', OTEL_SERVICE_NAME: 'checkout-agent' });
    const tracing = await otelTracingFromEnv({
      serviceName: 'agent-name',
      load: loader(memory).load,
      log,
    });
    expect(tracing).toBeDefined();
    expect(log.log).toHaveBeenCalledWith('lousho server: exporting OTel traces to http://collector:4318/v1/traces');

    await createAgent(withOtelTracing({ name: 'support', provider: mockModel(['Hi.']) }, tracing)).send('Hello');
    await tracing!.shutdown();

    const spans = memory.getFinishedSpans();
    expect(spans.map((span) => span.name)).toEqual(expect.arrayContaining(['invoke_agent support', 'chat mock-model']));
    const root = spans.find((span) => span.name === 'invoke_agent support')!;
    expect(root.attributes['gen_ai.operation.name']).toBe('invoke_agent');
    expect(root.resource.attributes['service.name']).toBe('checkout-agent');
  });

  it("names the service after the agent when OTEL_SERVICE_NAME is unset, and reads OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", async () => {
    const memory = new InMemorySpanExporter();
    otelEnv({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://collector:4318/custom' });
    const tracing = await otelTracingFromEnv({
      serviceName: 'agent-name',
      load: loader(memory).load,
      log: quiet(),
    });
    await createAgent(withOtelTracing({ provider: mockModel(['Hi.']) }, tracing)).send('Hello');
    await tracing!.shutdown();
    expect(memory.getFinishedSpans()[0].resource.attributes['service.name']).toBe('agent-name');
  });

  it('logs the packages to install, and returns undefined, when the OTel packages are missing', async () => {
    const log = quiet();
    const load = async (name: string) => {
      throw Object.assign(new Error(`Cannot find package '${name}'`), { code: 'ERR_MODULE_NOT_FOUND' });
    };
    otelEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c:4318' });
    expect(await otelTracingFromEnv({ serviceName: 'a', load, log })).toBeUndefined();
    const message = log.error.mock.calls[0][0] as string;
    expect(message).toContain('@opentelemetry/api, @opentelemetry/sdk-trace-node, @opentelemetry/resources, @opentelemetry/exporter-trace-otlp-http');
    expect(message).toContain('npm install @opentelemetry/api @opentelemetry/sdk-trace-node@^2 @opentelemetry/resources@^2 @opentelemetry/exporter-trace-otlp-http');
  });

  it('logs any other start-up error and returns undefined', async () => {
    const log = quiet();
    const load = async () => ({});
    otelEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c:4318' });
    expect(await otelTracingFromEnv({ serviceName: 'a', load, log })).toBeUndefined();
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('traces are not exported: '));
  });
});

describe('otlpTracesEndpoint', () => {
  it('prefers the traces endpoint, appends /v1/traces to the base one, and keeps an unparsable value', () => {
    expect(otlpTracesEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://a:4318', OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://b/t' })).toBe('http://b/t');
    expect(otlpTracesEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://a:4318' })).toBe('http://a:4318/v1/traces');
    expect(otlpTracesEndpoint({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'not a url' })).toBe('not a url');
    expect(otlpTracesEndpoint({})).toBeUndefined();
  });
});

describe('withOtelTracing / agentWithOtelTracing', () => {
  const otel = (): OtelTracing & { exporter: ReturnType<typeof recording> } => ({ exporter: recording(), shutdown: async () => {} });

  it('leave the config and the agent as they are without tracing', () => {
    const config = { provider: mockModel(['Hi.']) };
    expect(withOtelTracing(config, undefined)).toBe(config);
    const agent = createAgent(config);
    expect(agentWithOtelTracing(agent, undefined)).toBe(agent);
  });

  it("keep the agent's own exporter: both get every span", async () => {
    const own = recording();
    const tracing = otel();
    await createAgent(withOtelTracing({ provider: mockModel(['Hi.']), exporter: own }, tracing)).send('Hello');
    expect(own.ended.map((span) => span.name)).toEqual(tracing.exporter.ended.map((span) => span.name));
    expect(own.ended.length).toBeGreaterThan(0);
  });

  it('rebuild a createAgent() agent with the exporter, and log one that was not built by createAgent()', async () => {
    const tracing = otel();
    const traced = agentWithOtelTracing(createAgent({ provider: mockModel(['Hi.']) }), tracing);
    await traced.send('Hello');
    expect(tracing.exporter.ended.some((span) => span.attributes['gen_ai.operation.name'] === 'invoke_agent')).toBe(true);

    const log = { error: vi.fn() };
    const foreign = { ...traced };
    expect(agentWithOtelTracing(foreign, tracing, log)).toBe(foreign);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('was not built by createAgent()'));
  });
});
