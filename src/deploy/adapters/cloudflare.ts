/**
 * cloudflare-worker deployment adapter (LOU-I3).
 *
 * scaffold(): loads + validates the AgentSpec (same loader as node-server),
 *   checks every tool/provider is usable on Workers, then writes:
 *     - agent.config.js  the validated spec as an ES module default export
 *     - worker.ts        a module Worker whose fetch(request, env) serves the
 *                        `/chat` API of the node server (sessions, SSE,
 *                        approvals, bearer auth; LOU-D51) - no node:* imports
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
import { builtinModules } from 'node:module';
import * as zlib from 'node:zlib';
import { DeploymentAdapter } from '../types';
import { AgentSpec } from '../../spec/schema';
import { SDKError } from '../../execution/errors';
import type { DefinedSchedule } from '../../schedules/defineSchedule';
import { specSchedules } from '../../schedules/specSchedules';
import {
  WORKER_RUNTIME_SPECIFIER,
  loadTsup,
  sdkRuntimePlugin,
  workerNodeShimPlugin,
  workerSandboxShimPlugin,
  writeFile,
} from '../bundle';
import { CHECKPOINT_KV_BINDING } from '../checkpointBinding';
import { HTTP_ALLOW_BINDING } from '../../tools/built-in/workerHttp';
import { agentConfigModuleSource, loadAgentSpecForDeploy } from './node-server';

/**
 * Built-in tools that work without Node builtins (see runtime.worker.ts).
 * 'http' (M3a) is the Worker's own http_request: listed host names only, from
 * the LOUSHO_HTTP_ALLOW binding (src/tools/built-in/workerHttp.ts).
 */
export const WORKER_SUPPORTED_TOOLS = ['current-date', 'day-name', 'http'];
/**
 * Provider types registered in the Worker bundle (see runtime.worker.ts).
 *
 * 'openai', 'anthropic' (LOU-K3) and 'openrouter' (M3a) are real,
 * network-calling providers - implemented on the Vercel `ai` SDK's
 * fetch()-based generateText/streamText plus @ai-sdk/openai /
 * @ai-sdk/anthropic, which have no `node:*` imports in their dependency
 * graph (the build's leak check verifies every bundle). 'ollama' remains
 * unsupported here (see runtime.worker.ts's doc comment for why).
 */
export const WORKER_SUPPORTED_PROVIDERS = ['mock', 'openai', 'anthropic', 'openrouter'];

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
  return name || 'lousho-agent';
}

/** Cloudflare's day-of-week is 1-7 with 1 = Sunday (not cron's 0/7 = Sunday): only `*` and day names mean the same everywhere. */
const CLOUDFLARE_DAY_OF_WEEK = /^(\*|[A-Za-z]{3}([-,][A-Za-z]{3})*)$/;

function invalidCron(name: string, problem: string): never {
  throw new SDKError(`cloudflare-worker: cron trigger '${name}' ${problem}`, 'LOUSHO_SCHEDULE_INVALID');
}

/**
 * The deduplicated `[triggers] crons` of the spec's cron triggers. Throws a
 * LOUSHO_SCHEDULE_INVALID SDKError naming the trigger for what Cloudflare would
 * not fire: a timezone (crons are UTC), `@daily`-style shortcuts, anything but
 * five fields, a numeric day-of-week (Cloudflare counts 1 as Sunday).
 */
export function workerCrons(spec: AgentSpec): string[] {
  return [...new Set(specSchedules(spec.triggers).map(workerCron))];
}

function workerCron(schedule: DefinedSchedule): string {
  const fields = schedule.cron.trim().split(/\s+/);
  const problem = cronProblem(schedule, fields);
  if (problem) invalidCron(schedule.name as string, problem);
  return fields.join(' ');
}

/** Why Cloudflare would not fire `schedule`, if it would not. */
function cronProblem(schedule: DefinedSchedule, fields: string[]): string | undefined {
  if (schedule.timezone) return `sets timezone '${schedule.timezone}', but Cloudflare cron triggers always run in UTC: remove it and write the expression in UTC.`;
  if (fields.length !== 5) return `uses '${schedule.cron}', which Cloudflare does not accept: write five fields (minute hour day-of-month month day-of-week), for example '0 9 * * MON'.`;
  if (!CLOUDFLARE_DAY_OF_WEEK.test(fields[4])) return `uses day-of-week '${fields[4]}': Cloudflare numbers days 1-7 from Sunday, so write day names (MON-FRI) or '*'.`;
  return undefined;
}

/** The commented `[vars]` block for the `http` tool's allowlist (M3a), when the spec lists `http`. */
function httpAllowVars(spec: AgentSpec): string[] {
  if (!(spec.tools ?? []).includes('http')) return [];
  return [
    `# The http tool reaches only the host names listed in ${HTTP_ALLOW_BINDING}`,
    '# (comma-separated; `*.example.com` matches subdomains only). Unset, every',
    '# request is refused. IP-address hosts are always refused.',
    '#',
    '# [vars]',
    `# ${HTTP_ALLOW_BINDING} = "api.example.com"`,
    '',
  ];
}

export function wranglerTomlSource(spec: AgentSpec): string {
  const crons = workerCrons(spec);
  const triggers =
    crons.length === 0
      ? []
      : [
          "# Cron triggers from the spec (UTC): Cloudflare calls the Worker's scheduled() for each.",
          '[triggers]',
          `crons = [${crons.map((cron) => JSON.stringify(cron)).join(', ')}]`,
          '',
        ];
  return [
    '# Generated by `lousho build --target=cloudflare-worker`.',
    `name = "${workerName(spec)}"`,
    'main = "dist/worker.js"',
    `compatibility_date = "${COMPATIBILITY_DATE}"`,
    '# dist/worker.js is already a single, fully bundled ES module built by',
    '# `lousho build` - upload it exactly as built.',
    'no_bundle = true',
    '',
    ...triggers,
    ...httpAllowVars(spec),
    '# LOU-T2, LOU-D51: sessions (chat history), durable execution',
    '# (pause/resume, e.g. an approval-gated tool call) and paused approvals live',
    `# in one KV namespace bound under ${CHECKPOINT_KV_BINDING}. Uncomment and fill in the`,
    '# namespace id(s) below after creating the namespace yourself:',
    '#',
    `#   npx wrangler kv namespace create ${CHECKPOINT_KV_BINDING}`,
    `#   npx wrangler kv namespace create ${CHECKPOINT_KV_BINDING} --preview`,
    '#',
    '# Without this binding the Worker still runs, but keeps sessions in the',
    '# memory of one isolate, which Cloudflare may recycle at any time.',
    '#',
    '# Secrets (not part of this file): the bearer token every route except',
    '# GET /health requires, and the provider API key, e.g.',
    '#',
    '#   npx wrangler secret put LOUSHO_API_TOKEN',
    '#   npx wrangler secret put OPENAI_API_KEY',
    '#',
    '# [[kv_namespaces]]',
    `# binding = "${CHECKPOINT_KV_BINDING}"`,
    '# id = "<production namespace id, from the command above>"',
    '# preview_id = "<preview namespace id, from the --preview command above>"',
    '',
  ].join('\n');
}

const WORKER_TS = `/**
 * Generated by \`lousho build --target=cloudflare-worker\`.
 *
 *   GET  /health                         -> 200 'ok'
 *   POST /chat                           -> { sessionId, input } in, the turn streamed as SSE out
 *                                           (the deprecated { message, sessionId? } returns an
 *                                           ExecutionResult)
 *   GET  /chat/:sessionId                -> the session's transcript and pending approvals
 *   POST /chat/:sessionId/approvals/:id  -> { approved, note? } or { answer }, streamed
 *
 * Worker bindings (see wrangler.toml): the \`LOUSHO_API_TOKEN\` secret makes every
 * route except /health require 'Authorization: Bearer <token>'; the provider API
 * key is a secret named <TYPE>_API_KEY (e.g. OPENAI_API_KEY); the
 * \`${CHECKPOINT_KV_BINDING}\` KV namespace keeps sessions, checkpoints and approvals between
 * requests (without it they live in the memory of one isolate).
 */
import { agentSpecSchema, handleWorkerRequest, handleWorkerScheduled } from '${WORKER_RUNTIME_SPECIFIER}';
import agentConfig from './agent.config.js';

const spec = agentSpecSchema.parse(agentConfig);

export async function fetch(request: Request, env: Record<string, unknown> = {}): Promise<Response> {
  return handleWorkerRequest(request, env, spec);
}

/** Runs the spec's cron triggers (wrangler.toml \`[triggers] crons\`): one agent turn per matching trigger. */
export async function scheduled(
  controller: { cron: string; scheduledTime?: number },
  env: Record<string, unknown> = {},
  ctx: { waitUntil(promise: Promise<unknown>): void }
): Promise<void> {
  return handleWorkerScheduled(controller, env, ctx, spec);
}

export default { fetch, scheduled };
`;

/**
 * Runtime probes the leak check accepts (LOU-D28c). `ai` v7 and its
 * `@ai-sdk/provider-utils` v5 ship one `dist/index.js` for every runtime (no
 * browser/worker/edge export condition to pick instead) and load these
 * builtins through `globalThis.process?.getBuiltinModule?.(id)`, never through
 * an import, so there is nothing for esbuild to resolve or shim:
 *  - node:module, node:dns: provider-utils' SSRF-safe download fetch, used only
 *    when `isNodeRuntime()` (false on workerd, which falls back to fetch());
 *  - node:diagnostics_channel, node:async_hooks: `ai`'s telemetry tracing
 *    channel, used only when `process.release.name === 'node'`, and a missing
 *    module is treated as "no subscribers".
 * Only these ids, and only as the argument of a `getBuiltinModule` /
 * `loadBuiltinModule` call, are exempt; any other `node:` string still fails.
 */
const WORKER_SAFE_BUILTIN_PROBE = /\b(?:get|load)BuiltinModule\d*(?:\?\.)?\(\s*(["'`])node:(?:module|dns|diagnostics_channel|async_hooks)\1\s*\)/g;

/** Returns every `node:`-prefixed module specifier referenced in `source`. */
export function findNodeBuiltinReferences(source: string): string[] {
  const code = source.replace(WORKER_SAFE_BUILTIN_PROBE, '');
  // A bare `from "fs"` is as much a leak as `node:fs` (esbuild drops the prefix when it leaves a builtin external).
  const bare = new RegExp(`(?:from|import\\(|require\\()\\s*(["'\`](?:${builtinModules.join('|')})["'\`])`, 'g');
  const found = [...(code.match(/["'`]node:[a-z_/]+["'`]/g) || []), ...Array.from(code.matchAll(bare), (match) => match[1])];
  return Array.from(new Set(found));
}

function assertProviderSupported(spec: AgentSpec): void {
  if (!WORKER_SUPPORTED_PROVIDERS.includes(spec.provider.type.toLowerCase())) {
    throw new SDKError(
      `provider '${spec.provider.type}' is not supported by the cloudflare-worker target yet ` +
        `(supported: ${WORKER_SUPPORTED_PROVIDERS.join(', ')}). Use --target=node-server or --target=docker.`,
      'LOUSHO_DEPLOY_FAILED'
    );
  }
}

function assertToolsSupported(spec: AgentSpec): void {
  for (const tool of spec.tools || []) {
    if (!WORKER_SUPPORTED_TOOLS.includes(tool)) {
      throw new SDKError(
        `tool '${tool}' is not available on Cloudflare Workers ` +
          `(available: ${WORKER_SUPPORTED_TOOLS.join(', ')}). Use --target=node-server or --target=docker.`,
        'LOUSHO_DEPLOY_FAILED'
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
      esbuildPlugins: [workerSandboxShimPlugin(), workerNodeShimPlugin(), sdkRuntimePlugin()],
      // Keep `node:` prefixes: the shim plugin matches them (and the leak check below reports any left).
      removeNodeProtocol: false,
      clean: true,
      splitting: false,
      sourcemap: false,
      dts: false,
      // Set LOUSHO_BUILD_VERBOSE=1 to see tsup's own build log (and full bundling errors).
      silent: !process.env.LOUSHO_BUILD_VERBOSE,
    });

    const bundlePath = path.join(outDir, 'dist', 'worker.js');
    const leaked = findNodeBuiltinReferences(fs.readFileSync(bundlePath, 'utf8'));
    if (leaked.length > 0) {
      throw new SDKError(
        `cloudflare-worker build: Node builtins leaked into ${bundlePath}: ${leaked.join(', ')}`,
        'LOUSHO_DEPLOY_FAILED'
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
        `lousho build: cloudflare-worker bundle is ${formatBundleSize(sizeReport.bytes)}, which exceeds the ` +
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
