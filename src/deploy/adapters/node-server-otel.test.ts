/**
 * The built server exports OTel traces when OTEL_EXPORTER_OTLP_ENDPOINT is set:
 * scaffold + build a spec, run dist/server.js against a local collector stub,
 * and check one /chat turn arrives there as an `invoke_agent` span.
 *
 * @opentelemetry/sdk-trace-node and @opentelemetry/resources are the real
 * packages (dev dependencies, linked into the build's node_modules).
 * @opentelemetry/exporter-trace-otlp-http is not installed in this repo, so a
 * stub package stands in for it: it POSTs the finished spans as JSON (not the
 * OTLP encoding) to the same endpoint the real one would.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { NodeServerAdapter } from './node-server';
import { withBuildLock } from '../buildLock.testkit';

const SPEC = {
  name: 'otel-test-agent',
  prompt: 'You are a traced test agent.',
  provider: { type: 'mock', model: 'mock-model-1' },
};

const STUB_EXPORTER = `const url = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\\/+$/, '') + '/v1/traces';
class OTLPTraceExporter {
  export(spans, done) {
    const body = JSON.stringify({
      resourceSpans: [{
        resource: { attributes: spans[0] ? spans[0].resource.attributes : {} },
        scopeSpans: [{ spans: spans.map((span) => ({ name: span.name, attributes: span.attributes })) }],
      }],
    });
    fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body }).then(() => done({ code: 0 }), (error) => done({ code: 1, error }));
  }
  forceFlush() { return Promise.resolve(); }
  shutdown() { return Promise.resolve(); }
}
module.exports = { OTLPTraceExporter };
`;

interface Received {
  url: string;
  body: { resourceSpans: { resource: { attributes: Record<string, unknown> }; scopeSpans: { spans: { name: string; attributes: Record<string, unknown> }[] }[] }[] };
}

function startServer(outDir: string, env: Record<string, string>): Promise<{ child: ChildProcess; port: number; output: () => string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['dist/server.js', '--port=0'], {
      cwd: outDir,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const timer = setTimeout(() => reject(new Error(`server did not start: ${output}`)), 15_000);
    const onData = (chunk: Buffer) => {
      output += chunk;
      const match = output.match(/listening on http:\/\/[^:]+:(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve({ child, port: Number(match[1]), output: () => output });
      }
    };
    child.stdout!.on('data', onData);
    child.stderr!.on('data', onData);
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early (code ${code}): ${output}`));
    });
  });
}

async function chat(port: number): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${port}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'hello traced agent' }),
  });
  expect(res.status).toBe(200);
  expect((await res.json()).text).toBe('This is a mock response.');
}

/** Links an installed package of this repo into `outDir`'s node_modules (a junction, so Windows needs no privilege). */
function linkPackage(outDir: string, name: string): void {
  const target = path.dirname(require.resolve(`${name}/package.json`));
  const link = path.join(outDir, 'node_modules', ...name.split('/'));
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(target, link, 'junction');
}

describe('node-server build: OTel trace export', () => {
  let outDir: string;
  let collector: http.Server;
  let endpoint: string;
  const received: Received[] = [];

  beforeAll(async () => {
    collector = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        received.push({ url: req.url ?? '', body: JSON.parse(body) });
        res.writeHead(200).end('{}');
      });
    });
    await new Promise<void>((resolve) => collector.listen(0, '127.0.0.1', resolve));
    endpoint = `http://127.0.0.1:${(collector.address() as { port: number }).port}`;

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-node-server-otel-'));
    const specPath = path.join(dir, 'agent.json');
    fs.writeFileSync(specPath, JSON.stringify(SPEC));
    outDir = path.join(dir, 'out');
    await NodeServerAdapter.scaffold(specPath, outDir);
    await withBuildLock(() => NodeServerAdapter.build(outDir));
  }, 120_000);

  afterAll(() => {
    collector.close();
  });

  it('the generated server.ts sets up the exporter only behind the OTLP variables', () => {
    const server = fs.readFileSync(path.join(outDir, 'server.ts'), 'utf8');
    expect(server).toContain('const tracing = await otelTracingFromEnv({ serviceName: "otel-test-agent" });');
    expect(server).toContain('tracing ? specToAgent(spec, { store: storeFromEnv(), exporter: tracing.exporter }) : await createDeployedAgent(spec)');
    expect(server).toContain('tracing?.shutdown()');
    // The OTel SDK packages are resolved at run time, never bundled.
    const bundle = fs.readFileSync(path.join(outDir, 'dist', 'server.js'), 'utf8');
    expect(bundle).not.toContain('class NodeTracerProvider');
  });

  it("adds the exporter next to an agent directory's or an agent module's own", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-node-server-otel-src-'));
    const agentDir = path.join(dir, 'support-agent');
    fs.mkdirSync(agentDir);
    fs.writeFileSync(path.join(agentDir, 'agent.json'), JSON.stringify({ model: 'mock/mock-model-1', instructions: 'Hi.' }));
    await NodeServerAdapter.scaffold(agentDir, path.join(dir, 'dir-out'));
    const dirServer = fs.readFileSync(path.join(dir, 'dir-out', 'server.ts'), 'utf8');
    expect(dirServer).toContain('otelTracingFromEnv({ serviceName: "support-agent" })');
    expect(dirServer).toContain('createAgent(withOtelTracing({ ...resolved.config, store }, tracing))');

    const moduleFile = path.join(dir, 'agent.ts');
    fs.writeFileSync(moduleFile, "export default { model: 'mock/mock-model-1' };\n");
    await NodeServerAdapter.scaffold(moduleFile, path.join(dir, 'module-out'));
    const moduleServer = fs.readFileSync(path.join(dir, 'module-out', 'server.ts'), 'utf8');
    expect(moduleServer).toContain('agentWithOtelTracing(exported, tracing)');
    expect(moduleServer).toContain('createAgent(withOtelTracing({ ...exported, store }, tracing))');
  });

  it('serves without exporting, and names the packages to install, when they are missing', async () => {
    const { child, port, output } = await startServer(outDir, { OTEL_EXPORTER_OTLP_ENDPOINT: endpoint });
    try {
      await chat(port);
      expect(output()).toContain('OTEL_EXPORTER_OTLP_ENDPOINT is set but traces are not exported');
      expect(output()).toContain('@opentelemetry/sdk-trace-node, @opentelemetry/resources, @opentelemetry/exporter-trace-otlp-http');
      expect(received).toEqual([]);
    } finally {
      child.kill();
    }
  }, 30_000);

  it('POSTs an invoke_agent span for a /chat turn to OTEL_EXPORTER_OTLP_ENDPOINT, as OTEL_SERVICE_NAME', async () => {
    linkPackage(outDir, '@opentelemetry/sdk-trace-node');
    linkPackage(outDir, '@opentelemetry/resources');
    const stub = path.join(outDir, 'node_modules', '@opentelemetry', 'exporter-trace-otlp-http');
    fs.mkdirSync(stub, { recursive: true });
    fs.writeFileSync(path.join(stub, 'package.json'), JSON.stringify({ name: '@opentelemetry/exporter-trace-otlp-http', version: '0.0.0', main: 'index.js' }));
    fs.writeFileSync(path.join(stub, 'index.js'), STUB_EXPORTER);

    const { child, port, output } = await startServer(outDir, {
      OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
      OTEL_SERVICE_NAME: 'traced-service',
      OTEL_BSP_SCHEDULE_DELAY: '100',
    });
    try {
      expect(output()).toContain(`lousho server: exporting OTel traces to ${endpoint}/v1/traces`);
      await chat(port);
      const deadline = Date.now() + 10_000;
      const spans = () => received.flatMap((r) => r.body.resourceSpans.flatMap((rs) => rs.scopeSpans.flatMap((s) => s.spans)));
      while (!spans().some((span) => span.name.startsWith('invoke_agent')) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const root = spans().find((span) => span.name.startsWith('invoke_agent'));
      expect(root, output()).toBeDefined();
      expect(root!.attributes['gen_ai.operation.name']).toBe('invoke_agent');
      expect(spans().some((span) => span.attributes['gen_ai.operation.name'] === 'chat')).toBe(true);
      expect(received[0].url).toBe('/v1/traces');
      expect(received[0].body.resourceSpans[0].resource.attributes['service.name']).toBe('traced-service');
    } finally {
      child.kill();
    }
  }, 30_000);
});
