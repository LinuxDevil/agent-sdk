/**
 * cloudflare-worker deployment adapter (LOU-I3).
 *
 * scaffold(): loads + validates the AgentSpec (same loader as node-server),
 *   checks every tool/provider is usable on Workers, then writes:
 *     - agent.config.js  the validated spec as an ES module default export
 *     - worker.ts        a module Worker whose fetch(request, env) wraps the
 *                        static AgentExecutor.execute() (GET /health,
 *                        POST /chat) - no node:* imports anywhere
 *     - wrangler.toml    name / main / compatibility_date
 * build():    tsup, format 'esm', platform 'browser', everything bundled into
 *             dist/worker.js; then fails the build if any `node:` specifier
 *             leaked into the output, then measures the bundle's raw and
 *             gzip size and warns (does not fail the build) if it exceeds
 *             Workers' script size limit (see WORKER_SIZE_LIMIT_BYTES).
 * describe(): 'wrangler deploy', plus the measured bundle size and a
 *             pass/warn verdict against WORKER_SIZE_LIMIT_BYTES when a built
 *             bundle is present in outDir.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { DeploymentAdapter } from '../types';
import { AgentSpec } from '../../spec/schema';
import {
  WORKER_RUNTIME_SPECIFIER,
  loadTsup,
  sdkRuntimePlugin,
  workerSandboxShimPlugin,
  writeFile,
} from '../bundle';
import { CHECKPOINT_KV_BINDING } from '../checkpointBinding';
import { agentConfigModuleSource, loadAgentSpecForDeploy } from './node-server';

/** Built-in tools that work without Node builtins (see runtime.worker.ts). */
export const WORKER_SUPPORTED_TOOLS = ['current-date', 'day-name'];
/**
 * Provider types registered in the Worker bundle (see runtime.worker.ts).
 *
 * 'openai' and 'anthropic' (LOU-K3) are real, network-calling providers -
 * both implemented on the Vercel `ai` SDK's fetch()-based
 * generateText/streamText plus @ai-sdk/openai / @ai-sdk/anthropic, which
 * have no `node:*` imports anywhere in their dependency graph and are
 * genuinely Workers-compatible. 'ollama' and 'openrouter' remain
 * unsupported here (see runtime.worker.ts's doc comment for why).
 */
export const WORKER_SUPPORTED_PROVIDERS = ['mock', 'openai', 'anthropic'];

/** Pinned so a given SDK version always generates the same, reproducible config. */
const COMPATIBILITY_DATE = '2024-09-23';

/**
 * Cloudflare Workers script size limit (LOU-I3 AC: "bundle size stays under
 * Workers' free-tier limit for a minimal agent").
 *
 * As of Cloudflare's 2026-09-04 Workers changelog
 * (https://developers.cloudflare.com/changelog/post/2026-09-04-increased-worker-size-limit/,
 * cross-checked against https://developers.cloudflare.com/workers/platform/limits/),
 * Cloudflare replaced the old *compressed*-size limits - 3 MB gzip on the
 * Free plan, 10 MB gzip on paid plans - with a single 64 MiB *uncompressed*
 * limit that now applies to every plan, including Free. `wrangler`'s own
 * dry-run output still prints a gzip figure for reference, but gzip size is
 * no longer what Cloudflare enforces.
 *
 * Because this changed recently and Cloudflare has changed it before, this
 * constant intentionally documents its source above rather than being
 * asserted from memory - re-check
 * https://developers.cloudflare.com/workers/platform/limits/ if it is ever
 * suspected to be stale, and update this value (and the comment) rather than
 * silently drifting from Cloudflare's real limit.
 */
export const WORKER_SIZE_LIMIT_BYTES = 64 * 1024 * 1024;

export interface BundleSizeReport {
  /** Absolute path of the measured bundle file. */
  path: string;
  /** Raw (uncompressed) size on disk, in bytes - what Cloudflare enforces. */
  bytes: number;
  /** gzip-compressed size, in bytes - informational only (see WORKER_SIZE_LIMIT_BYTES). */
  gzipBytes: number;
  /** The limit `bytes` was compared against. */
  limitBytes: number;
  /** True when `bytes` exceeds `limitBytes`. */
  overLimit: boolean;
}

/** Formats a byte count as a human-readable KB/MB string for warnings and describe() output. */
export function formatBundleSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/**
 * Reads `bundlePath` off disk and measures its raw and gzip size, comparing
 * the raw (uncompressed) size against Cloudflare's real enforced limit - see
 * WORKER_SIZE_LIMIT_BYTES for where that number comes from.
 */
export function measureBundleSize(
  bundlePath: string,
  limitBytes: number = WORKER_SIZE_LIMIT_BYTES
): BundleSizeReport {
  const buffer = fs.readFileSync(bundlePath);
  const bytes = buffer.byteLength;
  const gzipBytes = zlib.gzipSync(buffer).byteLength;
  return { path: bundlePath, bytes, gzipBytes, limitBytes, overLimit: bytes > limitBytes };
}

export function workerName(spec: AgentSpec): string {
  const name = spec.name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/, '');
  return name || 'loushy-agent';
}

export function wranglerTomlSource(spec: AgentSpec): string {
  return [
    '# Generated by `loushy build --target=cloudflare-worker`.',
    `name = "${workerName(spec)}"`,
    'main = "dist/worker.js"',
    `compatibility_date = "${COMPATIBILITY_DATE}"`,
    '# dist/worker.js is already a single, fully bundled ES module built by',
    '# `loushy build` - upload it exactly as built.',
    'no_bundle = true',
    '',
    '# LOU-T2: durable execution (pause/resume across requests, e.g. an',
    '# approval-gated tool call) needs a KV namespace bound under',
    `# ${CHECKPOINT_KV_BINDING}. Uncomment and fill in the namespace id(s) below`,
    '# after creating the namespace yourself:',
    '#',
    `#   npx wrangler kv namespace create ${CHECKPOINT_KV_BINDING}`,
    `#   npx wrangler kv namespace create ${CHECKPOINT_KV_BINDING} --preview`,
    '#',
    '# Without this binding the Worker still runs normally - a request with no',
    '# durable KV namespace configured just skips checkpointing, exactly like',
    '# calling AgentExecutor.execute() with no checkpointStore at all.',
    '#',
    '# [[kv_namespaces]]',
    `# binding = "${CHECKPOINT_KV_BINDING}"`,
    '# id = "<production namespace id, from the command above>"',
    '# preview_id = "<preview namespace id, from the --preview command above>"',
    '',
  ].join('\n');
}

const WORKER_TS = `/**
 * Generated by \`loushy build --target=cloudflare-worker\`.
 *
 *   GET  /health -> 200 'ok'
 *   POST /chat   -> { message, sessionId? } in, AgentExecutor.execute()'s
 *                   ExecutionResult out
 *
 * Provider API keys come from Worker env bindings named <TYPE>_API_KEY
 * (e.g. \`wrangler secret put OPENAI_API_KEY\`).
 *
 * LOU-T2: pass a \`sessionId\` in the request body to opt a request into
 * durable checkpointing - this only takes effect when the Worker also has
 * an \`AGENT_CHECKPOINTS\` KV namespace binding configured (see
 * wrangler.toml's commented-out [[kv_namespaces]] block); with no binding
 * bound, \`sessionId\` is accepted but checkpointing is silently a no-op,
 * same as calling AgentExecutor.execute() with no checkpointStore at all.
 */
import { AgentExecutor, agentSpecSchema, checkpointStoreFromEnv, prepareWorkerSpec } from '${WORKER_RUNTIME_SPECIFIER}';
import agentConfig from './agent.config.js';

const MAX_BODY_BYTES = 1024 * 1024; // 1MB, same cap as \`loushy dev\`

const spec = agentSpecSchema.parse(agentConfig);

function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function fetch(request: Request, env: Record<string, unknown> = {}): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === 'GET' && url.pathname === '/health') {
    return new Response('ok', { status: 200, headers: { 'Content-Type': 'text/plain' } });
  }

  if (request.method === 'POST' && url.pathname === '/chat') {
    try {
      const declared = Number(request.headers.get('content-length') || 0);
      if (declared > MAX_BODY_BYTES) {
        return json(413, { error: 'Request body exceeds ' + MAX_BODY_BYTES + ' byte limit' });
      }
      const buffer = await request.arrayBuffer();
      if (buffer.byteLength > MAX_BODY_BYTES) {
        return json(413, { error: 'Request body exceeds ' + MAX_BODY_BYTES + ' byte limit' });
      }
      const body = new TextDecoder().decode(buffer);
      const { message, sessionId } = JSON.parse(body || '{}');
      if (typeof message !== 'string' || !message) {
        return json(400, { error: "Request body must be JSON with a 'message' string" });
      }
      if (sessionId !== undefined && typeof sessionId !== 'string') {
        return json(400, { error: "Request body's 'sessionId', if present, must be a string" });
      }
      const prepared = prepareWorkerSpec(spec, env);
      const checkpointStore = sessionId ? checkpointStoreFromEnv(env) : undefined;
      const result = await AgentExecutor.execute({
        ...prepared,
        input: message,
        sessionId,
        checkpointStore,
      });
      return json(200, result);
    } catch (error) {
      return json(500, { error: (error as Error).message });
    }
  }

  return new Response('not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
}

export default { fetch };
`;

/** Returns every `node:`-prefixed module specifier referenced in `source`. */
export function findNodeBuiltinReferences(source: string): string[] {
  return Array.from(new Set(source.match(/["'`]node:[a-z_/]+["'`]/g) || []));
}

function assertProviderSupported(spec: AgentSpec): void {
  if (!WORKER_SUPPORTED_PROVIDERS.includes(spec.provider.type.toLowerCase())) {
    throw new Error(
      `provider '${spec.provider.type}' is not supported by the cloudflare-worker target yet ` +
        `(supported: ${WORKER_SUPPORTED_PROVIDERS.join(', ')}). Use --target=node-server or --target=docker.`
    );
  }
}

function assertToolsSupported(spec: AgentSpec): void {
  for (const tool of spec.tools || []) {
    if (!WORKER_SUPPORTED_TOOLS.includes(tool)) {
      throw new Error(
        `tool '${tool}' is not available on Cloudflare Workers ` +
          `(available: ${WORKER_SUPPORTED_TOOLS.join(', ')}). Use --target=node-server or --target=docker.`
      );
    }
  }
}

export const CloudflareWorkerAdapter: DeploymentAdapter = {
  async scaffold(agentPath: string, outDir: string): Promise<void> {
    const spec = loadAgentSpecForDeploy(agentPath);

    assertProviderSupported(spec);
    assertToolsSupported(spec);

    writeFile(path.join(outDir, 'agent.config.js'), agentConfigModuleSource(spec));
    writeFile(path.join(outDir, 'worker.ts'), WORKER_TS);
    writeFile(path.join(outDir, 'wrangler.toml'), wranglerTomlSource(spec));
  },

  async build(outDir: string): Promise<void> {
    const { build } = await loadTsup();
    await build({
      config: false,
      entry: { worker: path.join(outDir, 'worker.ts') },
      outDir: path.join(outDir, 'dist'),
      format: ['esm'],
      platform: 'browser',
      target: 'es2022',
      outExtension: () => ({ js: '.js' }),
      noExternal: [/.*/],
      esbuildPlugins: [workerSandboxShimPlugin(), sdkRuntimePlugin()],
      clean: true,
      splitting: false,
      sourcemap: false,
      dts: false,
      // Set LOUSHY_BUILD_VERBOSE=1 to see tsup's own build log (and full bundling errors).
      silent: !process.env.LOUSHY_BUILD_VERBOSE,
    });

    const bundlePath = path.join(outDir, 'dist', 'worker.js');
    const leaked = findNodeBuiltinReferences(fs.readFileSync(bundlePath, 'utf8'));
    if (leaked.length > 0) {
      throw new Error(
        `cloudflare-worker build: Node builtins leaked into ${bundlePath}: ${leaked.join(', ')}`
      );
    }

    // LOU-I3 AC: report the built bundle's size against Workers' script size
    // limit (see WORKER_SIZE_LIMIT_BYTES) right away, not just when
    // describe() is later called. A warning (not a thrown error) because
    // Cloudflare's limits vary by plan and have changed over time - a build
    // that's over budget for one plan may still be deployable on another.
    const sizeReport = measureBundleSize(bundlePath);
    if (sizeReport.overLimit) {
      console.warn(
        `loushy build: cloudflare-worker bundle is ${formatBundleSize(sizeReport.bytes)}, which exceeds the ` +
          `${formatBundleSize(sizeReport.limitBytes)} Cloudflare Workers script size limit (see ` +
          `WORKER_SIZE_LIMIT_BYTES in src/deploy/adapters/cloudflare.ts). \`wrangler deploy\` will likely reject it.`
      );
    }
  },

  describe(outDir: string): string {
    try {
      const report = measureBundleSize(path.join(outDir, 'dist', 'worker.js'));
      const verdict = report.overLimit
        ? `WARNING: exceeds the ${formatBundleSize(report.limitBytes)} limit`
        : `within the ${formatBundleSize(report.limitBytes)} limit`;
      return (
        `wrangler deploy (bundle: ${formatBundleSize(report.bytes)} raw / ` +
        `${formatBundleSize(report.gzipBytes)} gzip, ${verdict})`
      );
    } catch {
      // Not built yet (or outDir doesn't hold a built bundle) - fall back to
      // the plain command with no size info.
      return 'wrangler deploy';
    }
  },
};
