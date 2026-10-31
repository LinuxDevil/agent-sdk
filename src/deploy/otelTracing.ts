/**
 * OpenTelemetry trace export for the server `lousho build --target=node-server|docker`
 * generates (see adapters/node-server.ts). When the standard
 * `OTEL_EXPORTER_OTLP_ENDPOINT` (or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`) is set
 * where the server runs, it registers an OTel tracer provider that sends spans
 * over OTLP/HTTP and attaches the SDK's OTel exporter (`createOtelTraceExporter()`,
 * the `./otel` subpath) to the agent, next to any exporter the agent already has.
 *
 * The OTel SDK and the OTLP exporter are not SDK dependencies, and the build does
 * not bundle them: the server imports them from its node_modules at start-up, only
 * when the variable is set. When they are missing it logs the packages to install
 * and serves without exporting traces. With the variable unset nothing here runs.
 * The exporter module (and with it `@opentelemetry/api`, an optional peer) is
 * imported lazily too, so a build without the OTel packages installed still builds
 * and runs (see runtimePeerPlugin() in ./bundle.ts).
 */
import type { createOtelTraceExporter } from '../execution/otel';
import type { Span, TraceExporter } from '../execution/tracing';
import { createAgent, createAgentConfigOf, type CreateAgentConfig, type SimpleAgent } from '../createAgent';

/** The packages the server imports to export traces, as `npm install` takes them. */
const OTEL_TRACE_PACKAGES = ['@opentelemetry/api', '@opentelemetry/sdk-trace-node@^2', '@opentelemetry/resources@^2', '@opentelemetry/exporter-trace-otlp-http'] as const;

/** A running trace export: the exporter to give the agent, and `shutdown()` to flush it before exit. */
export interface OtelTracing {
  exporter: TraceExporter;
  /** Exports the spans still buffered, then stops the tracer provider. */
  shutdown: () => Promise<void>;
}

export interface OtelTracingOptions {
  /** `service.name` when `OTEL_SERVICE_NAME` (or `service.name` in `OTEL_RESOURCE_ATTRIBUTES`) does not set one: the agent's name. */
  serviceName: string;
  /** Imports a package by name. Tests replace it. */
  load?: (name: string) => Promise<unknown>;
  log?: Pick<Console, 'log' | 'error'>;
}

interface SdkTraceNode {
  NodeTracerProvider: new (config: { resource: unknown; spanProcessors: unknown[] }) => {
    register: () => void;
    getTracer: (name: string) => NonNullable<Parameters<typeof createOtelTraceExporter>[0]>['tracer'];
    shutdown: () => Promise<void>;
  };
  BatchSpanProcessor: new (exporter: unknown) => unknown;
}

interface Resource {
  merge: (other: Resource) => Resource;
}

interface Resources {
  defaultResource: () => Resource;
  resourceFromAttributes: (attributes: Record<string, string>) => Resource;
  detectResources: (config: { detectors: unknown[] }) => Resource;
  envDetector: unknown;
}

interface OtlpHttp {
  OTLPTraceExporter: new () => unknown;
}

/** A variable specifier, so the build leaves these imports to run time instead of bundling them. */
const importPackage = (name: string): Promise<unknown> => import(name);

/** The trace endpoint the variables name, without credentials; `undefined` when neither is set. */
export function otlpTracesEndpoint(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const traces = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim();
  const base = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  const endpoint = traces || (base ? base.replace(/\/+$/, '') + '/v1/traces' : undefined);
  if (!endpoint) return undefined;
  try {
    const url = new URL(endpoint);
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return endpoint;
  }
}

/** A package's named exports: a CommonJS package imported from ESM may put them under `default`. */
async function exportsOf<T>(load: (name: string) => Promise<unknown>, name: string): Promise<T> {
  const mod = (await load(name)) as T & { default?: T };
  return mod.default && typeof mod.default === 'object' ? { ...mod.default, ...mod } : mod;
}

function isModuleNotFound(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND';
}

/**
 * Starts exporting traces over OTLP/HTTP when `OTEL_EXPORTER_OTLP_ENDPOINT` or
 * `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` is set; `undefined` (and nothing imported)
 * when neither is, and when the OTel packages cannot be loaded (logged).
 * `OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES`, `OTEL_EXPORTER_OTLP_HEADERS`
 * and the `OTEL_BSP_*` settings apply as the OTel SDK reads them.
 */
export async function otelTracingFromEnv(options: OtelTracingOptions): Promise<OtelTracing | undefined> {
  const log = options.log ?? console;
  const endpoint = otlpTracesEndpoint();
  if (!endpoint) return undefined;
  const load = options.load ?? importPackage;
  try {
    const { createOtelTraceExporter } = await import('../execution/otel');
    const { NodeTracerProvider, BatchSpanProcessor } = await exportsOf<SdkTraceNode>(load, '@opentelemetry/sdk-trace-node');
    const resources = await exportsOf<Resources>(load, '@opentelemetry/resources');
    const { OTLPTraceExporter } = await exportsOf<OtlpHttp>(load, '@opentelemetry/exporter-trace-otlp-http');
    // The env detector (OTEL_SERVICE_NAME, OTEL_RESOURCE_ATTRIBUTES) wins over the agent-name default.
    const resource = resources
      .defaultResource()
      .merge(resources.resourceFromAttributes({ 'service.name': options.serviceName }))
      .merge(resources.detectResources({ detectors: [resources.envDetector] }));
    const provider = new NodeTracerProvider({ resource, spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())] });
    provider.register();
    log.log('lousho server: exporting OTel traces to ' + endpoint);
    return {
      exporter: createOtelTraceExporter({ tracer: provider.getTracer('lousho') }),
      shutdown: () => provider.shutdown(),
    };
  } catch (error) {
    const reason = isModuleNotFound(error)
      ? `it needs ${OTEL_TRACE_PACKAGES.map((name) => name.replace(/@[^@/]*$/, '')).join(', ')}. ` +
        `Install them next to dist/server.js (npm install ${OTEL_TRACE_PACKAGES.join(' ')}, or add them to the build's package.json dependencies for the docker image)`
      : (error as Error).message;
    log.error(`[lousho server] OTEL_EXPORTER_OTLP_ENDPOINT is set but traces are not exported: ${reason}. See docs/observability.md.`);
    return undefined;
  }
}

/** One exporter that hands every span to each of `exporters`, in order. */
function fanOut(exporters: TraceExporter[]): TraceExporter {
  return {
    onSpanStart: (span: Span) => exporters.forEach((exporter) => exporter.onSpanStart(span)),
    onSpanEnd: (span: Span) => exporters.forEach((exporter) => exporter.onSpanEnd(span)),
  };
}

/** `config` with the OTel exporter added next to its own `exporter`; `config` itself without `tracing`. */
export function withOtelTracing<T extends CreateAgentConfig>(config: T, tracing: OtelTracing | undefined): T {
  if (!tracing) return config;
  return { ...config, exporter: config.exporter ? fanOut([config.exporter, tracing.exporter]) : tracing.exporter };
}

/**
 * A built agent with the OTel exporter added: rebuilt from the config it was
 * created with (an agent cannot take an exporter after the fact). `agent`
 * itself without `tracing`, or (logged) when it was not built by `createAgent()`.
 */
export function agentWithOtelTracing(agent: SimpleAgent, tracing: OtelTracing | undefined, log: Pick<Console, 'error'> = console): SimpleAgent {
  if (!tracing) return agent;
  const config = createAgentConfigOf(agent);
  if (!config) {
    log.error('[lousho server] the exported agent was not built by createAgent(), so its traces are not exported: export its config instead.');
    return agent;
  }
  return createAgent(withOtelTracing(config, tracing));
}
