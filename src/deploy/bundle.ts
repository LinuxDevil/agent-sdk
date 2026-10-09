/**
 * Shared bundling helpers for the built-in deployment adapters (LOU-I2+).
 *
 * Scaffolded entrypoints (server.ts / worker.ts) import the SDK through a
 * virtual specifier, `@lousho/build-ai-agent/deploy-runtime` (or
 * `.../deploy-runtime-worker`). At build time sdkRuntimePlugin() resolves
 * that specifier to the runtime source file of the SDK copy that is
 * running `lousho build` - so the output is bundled against exactly the
 * SDK version that generated it, and building works from any outDir
 * (including a temp dir with no node_modules of its own).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { builtinModules } from 'node:module';
import type { OnResolveResult, Plugin, ResolveResult } from 'esbuild';
import { SDKError } from '../execution/errors';

export const RUNTIME_SPECIFIER = '@lousho/build-ai-agent/deploy-runtime';
export const WORKER_RUNTIME_SPECIFIER = '@lousho/build-ai-agent/deploy-runtime-worker';

/**
 * Walks up from this module's directory to the @lousho/build-ai-agent
 * package root. Works both from source (src/deploy/) and from the bundled
 * CLI (dist/cli/build.js), in a checkout or an installed node_modules copy.
 */
export function findSdkRoot(startDir: string = __dirname): string {
  let dir = startDir;
  for (;;) {
    if (isSdkPackageRoot(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new SDKError(
        `lousho build: could not locate the @lousho/build-ai-agent package root above ${startDir}`,
        'LOUSHO_DEPLOY_FAILED'
      );
    }
    dir = parent;
  }
}

/** True when `dir` holds the readable package.json of @lousho/build-ai-agent. */
function isSdkPackageRoot(dir: string): boolean {
  const pkgPath = path.join(dir, 'package.json');
  if (!fs.existsSync(pkgPath)) return false;
  try {
    return JSON.parse(fs.readFileSync(pkgPath, 'utf8')).name === '@lousho/build-ai-agent';
  } catch {
    // not a readable package.json - keep walking up
    return false;
  }
}

function runtimeSourceFile(fileName: string): string {
  const file = path.join(findSdkRoot(), 'src', 'deploy', fileName);
  if (!fs.existsSync(file)) {
    throw new SDKError(`lousho build: SDK deploy runtime source not found at ${file}`, 'LOUSHO_DEPLOY_FAILED');
  }
  return file;
}

/**
 * esbuild plugin mapping the virtual runtime specifiers to the SDK's runtime
 * sources. `sdkEntry: 'worker'` (cloudflare-worker target) resolves agent
 * code's `@lousho/build-ai-agent` to the Worker-safe subset in ./workerSdk.ts
 * instead of the package's main entry, which imports Node-only modules.
 */
export function sdkRuntimePlugin({ sdkEntry = 'main' }: { sdkEntry?: 'main' | 'worker' } = {}): Plugin {
  return {
    name: 'lousho-deploy-runtime',
    setup(build) {
      build.onResolve({ filter: /^@lousho\/build-ai-agent\/deploy-runtime(-worker)?$/ }, (args) => ({
        path: runtimeSourceFile(
          args.path === WORKER_RUNTIME_SPECIFIER ? 'runtime.worker.ts' : 'runtime.ts'
        ),
      }));
      // An agent directory's own `import ... from '@lousho/build-ai-agent'` bundles this SDK copy
      // (the one the runtime above comes from), so tools, schedules and channels share its classes.
      build.onResolve({ filter: /^@lousho\/build-ai-agent$/ }, () => ({
        path: sdkEntry === 'worker' ? runtimeSourceFile('workerSdk.ts') : path.join(findSdkRoot(), 'src', 'index.ts'),
      }));
      // N10a: an agent directory's auth.ts imports its helpers from the auth subpath.
      build.onResolve({ filter: /^@lousho\/build-ai-agent\/auth$/ }, () => ({
        path: path.join(findSdkRoot(), 'src', 'auth', 'index.ts'),
      }));
    },
  };
}

/**
 * esbuild plugin (cloudflare-worker target only) that redirects the SDK's
 * internal `security/sandboxCore` imports to the Worker-safe shim in
 * ./shims/sandboxCore.worker.ts - the real module's NoopSandbox needs
 * node:child_process, which Workers don't have. N14: and the optional peer
 * `quickjs-emscripten` (code mode) to ./shims/quickjs.worker.ts, so the
 * Emscripten runtime never lands in a Worker bundle.
 */
export function workerSandboxShimPlugin(): Plugin {
  const shim = path.join(findSdkRoot(), 'src', 'deploy', 'shims', 'sandboxCore.worker.ts');
  const quickjs = path.join(findSdkRoot(), 'src', 'deploy', 'shims', 'quickjs.worker.ts');
  return {
    name: 'lousho-worker-sandbox-shim',
    setup(build) {
      build.onResolve({ filter: /[\\/]security[\\/]sandboxCore$|^\.\/sandboxCore$/ }, (args) => {
        if (path.resolve(args.importer) === shim) return undefined;
        return { path: shim };
      });
      build.onResolve({ filter: /^quickjs-emscripten$/ }, () => ({ path: quickjs }));
    },
  };
}

/**
 * The only SDK modules whose Node-only imports `workerNodeShimPlugin` replaces:
 * what `createAgent()` reaches. A Node builtin imported anywhere else (a
 * provider, a tool) is not shimmed, so the build's `node:` leak check fails it.
 */
const NODE_SHIMMED_IMPORTERS = ['createAgent', 'session/sessionStore', 'storage/fileNames', 'session/AgentSession', 'projectInstructions', 'tools/mcp/connect'];

/**
 * esbuild plugin (cloudflare-worker target only) that redirects the `node:*`
 * and MCP stdio imports of the modules in NODE_SHIMMED_IMPORTERS to the
 * Worker-safe shim in ./shims/node.worker.ts (LOU-D51).
 */
export function workerNodeShimPlugin(): Plugin {
  const shim = path.join(findSdkRoot(), 'src', 'deploy', 'shims', 'node.worker.ts');
  const shimmed = (importer: string) => NODE_SHIMMED_IMPORTERS.some((name) => importer.replace(/\\/g, '/').endsWith(`/src/${name}.ts`));
  return {
    name: 'lousho-worker-node-shim',
    setup(build) {
      build.onResolve({ filter: /^node:|^@modelcontextprotocol\/sdk\/client\/stdio\.js$/ }, (args) => (shimmed(args.importer) ? { path: shim } : undefined));
    },
  };
}

/**
 * esbuild plugin (cloudflare-worker target only) that leaves the optional
 * peers of the providers a Worker cannot run external:
 * 'ollama-ai-provider' / 'ollama-ai-provider-v2' for 'ollama', the one
 * built-in provider not in WORKER_SUPPORTED_PROVIDERS.
 *
 * Needed since LOU-R1: llm.ts now imports ./builtinProviders.ts (lazy
 * registration on a create() miss), which statically imports every built-in
 * provider module - so OllamaProvider and its lazy `import('ollama-ai-provider*')`
 * specifiers reach the Worker bundle, whose "inline everything" noExternal
 * would otherwise bundle those packages wholesale (where installed) or fail the
 * build with "Could not resolve" (where they are not). A plugin result of
 * `external: true` wins over noExternal, so the import() stays a lazy
 * runtime specifier behind OllamaProvider's first generate()/stream() -
 * code no Worker ever reaches: the adapter rejects a non-worker provider
 * before a spec is scaffolded, and the workerSdk has no OllamaProvider export.
 */
export function workerUnsupportedPeerPlugin(): Plugin {
  // H2 adds `@earendil-works/pi-ai` (subpaths included): same "stay a lazy
  // runtime specifier" treatment, and equally unreachable in a Worker.
  const filter = /^(?:ollama-ai-provider(?:-v2)?|@earendil-works\/pi-ai)(?:\/.*)?$/;
  return {
    name: 'lousho-worker-unsupported-peer',
    setup(build) {
      build.onResolve({ filter }, (args) => ({ path: args.path, external: true }));
    },
  };
}

/**
 * The specifiers the `@lousho/build-ai-agent/worker` entry leaves external
 * (#289): `ai`, `zod` and `@opentelemetry/api` are the SDK's own peers a
 * user installs, and `@ai-sdk/openai` / `@ai-sdk/anthropic` are the
 * provider packages a real `openai`/`anthropic`/`openrouter` agent lazy-
 * loads on first generate()/stream() - they must come from the user's
 * install so they share the user's `ai` copy and version pairing. Every
 * other package specifier is bundled into the entry (or shimmed by
 * workerEntryPlugins()), so a user's bundler has nothing else to resolve.
 * Shared by tsup.config.ts (the real build) and src/deploy/worker.test.ts
 * (the regression test), which must agree on what stays a specifier.
 */
export const WORKER_ENTRY_EXTERNALS = ['ai', 'zod', '@opentelemetry/api', '@ai-sdk/openai', '@ai-sdk/anthropic'];

/**
 * The esbuild plugins that build the Worker-safe
 * `@lousho/build-ai-agent/worker` entry (src/deploy/worker.ts ->
 * dist/deploy/worker.*) - the same shims the cloudflare-worker adapter
 * applies at `lousho build` time, baked into the published entry instead
 * (#289): `workerNodeShimPlugin` and `workerSandboxShimPlugin` redirect the
 * `node:` / MCP-stdio / sandbox / QuickJS imports `createAgent()` reaches,
 * so a user's own bundler (which has no shim of its own) never sees a Node
 * specifier. `ollama-ai-provider(-v2)` is redirected to
 * ./shims/ollama.worker.ts rather than left external like the adapter
 * build does: an external specifier would still have to resolve in the
 * user's build, and the optional package is usually not installed.
 * `@modelcontextprotocol/sdk` gets the same treatment in ./shims/mcp.worker.ts:
 * external would either fail the user's build (peer not installed) or drag
 * ~700 KB of MCP SDK + ajv into every Worker (peer installed), so
 * `mcpServers` fails on first connect instead. Used by tsup.config.ts and
 * by src/deploy/worker.test.ts, so the test guards exactly what is shipped.
 */
export function workerEntryPlugins(): Plugin[] {
  const ollama = path.join(findSdkRoot(), 'src', 'deploy', 'shims', 'ollama.worker.ts');
  const mcp = path.join(findSdkRoot(), 'src', 'deploy', 'shims', 'mcp.worker.ts');
  const pi = path.join(findSdkRoot(), 'src', 'deploy', 'shims', 'pi.worker.ts');
  return [
    workerSandboxShimPlugin(),
    workerNodeShimPlugin(),
    {
      name: 'lousho-worker-ollama-shim',
      setup(build) {
        build.onResolve({ filter: /^ollama-ai-provider(?:-v2)?$/ }, () => ({ path: ollama }));
      },
    },
    {
      // H2: the 'pi' provider's lazy `@earendil-works/pi-ai` imports become
      // the shim's coded failure (pi is Node-only).
      name: 'lousho-worker-pi-shim',
      setup(build) {
        build.onResolve({ filter: /^@earendil-works\/pi-ai(?:\/.*)?$/ }, (args) =>
          args.importer === pi ? undefined : { path: pi }
        );
      },
    },
    {
      name: 'lousho-worker-mcp-shim',
      setup(build) {
        build.onResolve({ filter: /^@modelcontextprotocol\/sdk(?:\/.*)?$/ }, (args) =>
          args.importer === mcp ? undefined : { path: mcp }
        );
      },
    },
  ];
}

const SKIP_BUILTIN_CHECK = 'lousho-skip-builtin-check';

/**
 * esbuild plugin (cloudflare-worker target only, registered last) for Node
 * builtins nothing else resolves: rather than failing the build with esbuild's
 * "Could not resolve", it leaves the import external and records who imported
 * it in `importers` (specifier -> importer paths), so the build's leak check
 * can name the file (M3b). A builtin that resolves normally (an npm polyfill,
 * a package's `browser` field) is resolved as before.
 */
export function workerBuiltinImportersPlugin(importers: Map<string, Set<string>>): Plugin {
  const names = builtinModules.map((name) => name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|');
  const builtin = new RegExp(`^(?:node:.+|(?:${names})(?:/.*)?)$`);
  const record = (specifier: string, importer: string) => importers.set(specifier, (importers.get(specifier) ?? new Set()).add(importer));
  return {
    name: 'lousho-worker-builtin-importers',
    setup(build) {
      build.onResolve({ filter: builtin }, async (args) => {
        if (isBuiltinCheck(args.pluginData)) return undefined;
        const resolved = await build.resolve(args.path, {
          kind: args.kind,
          importer: args.importer,
          resolveDir: args.resolveDir,
          pluginData: { [SKIP_BUILTIN_CHECK]: true },
        });
        if (resolved.errors.length === 0) return resolvedAs(resolved);
        record(args.path, args.importer);
        return { path: args.path, external: true };
      });
    },
  };
}

/** True for the plugin's own nested `build.resolve()` call. */
function isBuiltinCheck(pluginData: unknown): boolean {
  return (pluginData as Record<string, unknown> | undefined)?.[SKIP_BUILTIN_CHECK] === true;
}

/** An onResolve result that keeps what esbuild's own resolution found. */
function resolvedAs({ path: file, external, namespace, sideEffects, suffix, pluginData }: ResolveResult): OnResolveResult {
  return { path: file, external, namespace, sideEffects, suffix, pluginData };
}

/**
 * The SDK's optional peers: the keys of `peerDependenciesMeta` in its own
 * package.json whose `optional` is true. The SDK imports them lazily and
 * reports a coded missing-peer error when a code path needs one that is not
 * installed, so a build that bundles the SDK must leave them external.
 */
export function optionalPeers(): string[] {
  const pkg = JSON.parse(fs.readFileSync(path.join(findSdkRoot(), 'package.json'), 'utf8')) as {
    peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  };
  return Object.entries(pkg.peerDependenciesMeta ?? {})
    .filter(([, meta]) => meta.optional)
    .map(([name]) => name);
}

/** Optional peers of the SDK that `ai` (a hard dependency) imports statically, so they must stay in the bundle. */
const ALWAYS_BUNDLED = new Set(['@opentelemetry/api']);

/** tsup's `noExternal`/`external` for a build that bundles the SDK: everything inlined except the optional peers and their subpaths. */
export function bundleExternals(): { noExternal: RegExp[]; external: string[] } {
  const peers = optionalPeers().filter((name) => !ALWAYS_BUNDLED.has(name));
  const escaped = peers.map((name) => name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'));
  return { noExternal: [new RegExp(`^(?!(?:${escaped.join('|')})(?:/|$))`)], external: peers };
}

/**
 * Loads tsup lazily: it is only needed by `lousho build`, so the SDK's
 * normal runtime entrypoints never import it.
 */
export async function loadTsup(): Promise<typeof import('tsup')> {
  try {
    return await import('tsup');
  } catch (error) {
    throw new SDKError(
      `lousho build: the 'tsup' package is required to build deployment targets. ` +
        `Install it with \`npm install --save-dev tsup\`. (${(error as Error).message})`,
      'LOUSHO_DEPLOY_FAILED'
    );
  }
}

type TsupBuild = typeof import('tsup').build;
type TsupOptions = Parameters<TsupBuild>[0];

/** Turns esbuild's messages into one `LOUSHO_DEPLOY_FAILED` error; an unresolved package gets the same install advice `lousho dev` gives. */
function bundleError(texts: string[], files: string[]): SDKError {
  const unresolved = texts.map((text) => /Could not resolve "([^"]+)"/.exec(text)?.[1]).find((spec) => spec !== undefined && !/^(?:\.|\/|[A-Za-z]:[\\/])/.test(spec));
  const detail = texts.slice(0, 5).join('\n  ');
  const where = files.length > 0 ? ` (in ${[...new Set(files)].slice(0, 3).join(', ')})` : '';
  if (unresolved === undefined) {
    return new SDKError(`lousho build: bundling failed${where}:\n  ${detail}`, 'LOUSHO_DEPLOY_FAILED', {
      hint: 'Fix the error above, or set LOUSHO_BUILD_VERBOSE=1 to see the full build log.',
    });
  }
  const parts = unresolved.split('/');
  const pkg = unresolved.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  return new SDKError(`lousho build: cannot bundle the agent: '${unresolved}' could not be resolved${where}.`, 'LOUSHO_DEPLOY_FAILED', {
    hint: `Install it in the project that contains the agent directory (npm install ${pkg}), or move the agent directory inside a project that has it installed. Set LOUSHO_BUILD_VERBOSE=1 to see the full build log.`,
  });
}

/**
 * Runs tsup's `build`. tsup reports a bundling failure by printing esbuild's raw log
 * and a stack to stderr, setting `process.exitCode` and resolving as if it had
 * worked, which left a half-written `dist/` and a "success" line. This collects
 * esbuild's errors itself, silences the raw output (unless LOUSHO_BUILD_VERBOSE is
 * set), removes `<outDir>/dist`, and throws a coded `LOUSHO_DEPLOY_FAILED` instead.
 */
export async function buildBundle(build: TsupBuild, options: TsupOptions, outDir: string): Promise<void> {
  const verbose = Boolean(process.env.LOUSHO_BUILD_VERBOSE);
  const texts: string[] = [];
  const files: string[] = [];
  const collectErrors: Plugin = {
    name: 'lousho-collect-errors',
    setup(b) {
      b.onEnd((result) => {
        for (const message of result.errors) {
          texts.push(message.text);
          if (message.location?.file) files.push(message.location.file);
        }
      });
    },
  };
  const previousExitCode = process.exitCode;
  const consoleError = console.error;
  if (!verbose) console.error = () => {};
  let thrown: unknown;
  try {
    await build({
      ...options,
      esbuildPlugins: [...(options.esbuildPlugins ?? []), collectErrors],
      esbuildOptions: (esbuild, context) => {
        options.esbuildOptions?.(esbuild, context);
        if (!verbose) esbuild.logLevel = 'silent';
      },
    });
  } catch (error) {
    thrown = error;
  } finally {
    console.error = consoleError;
  }
  if (texts.length === 0 && thrown === undefined) return;
  process.exitCode = previousExitCode;
  fs.rmSync(path.join(outDir, 'dist'), { recursive: true, force: true });
  throw bundleError(texts.length > 0 ? texts : [thrown instanceof Error ? thrown.message : String(thrown)], files);
}

export function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}
