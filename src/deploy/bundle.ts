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
function findSdkRoot(startDir: string = __dirname): string {
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
 * node:child_process, which Workers don't have.
 */
export function workerSandboxShimPlugin(): Plugin {
  const shim = path.join(findSdkRoot(), 'src', 'deploy', 'shims', 'sandboxCore.worker.ts');
  return {
    name: 'lousho-worker-sandbox-shim',
    setup(build) {
      build.onResolve({ filter: /[\\/]security[\\/]sandboxCore$|^\.\/sandboxCore$/ }, (args) => {
        if (path.resolve(args.importer) === shim) return undefined;
        return { path: shim };
      });
    },
  };
}

/**
 * The only SDK modules whose Node-only imports `workerNodeShimPlugin` replaces:
 * what `createAgent()` reaches. A Node builtin imported anywhere else (a
 * provider, a tool) is not shimmed, so the build's `node:` leak check fails it.
 */
const NODE_SHIMMED_IMPORTERS = ['createAgent', 'execution/guardrails', 'session/sessionStore', 'session/AgentSession', 'projectInstructions', 'tools/mcp/connect'];

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

export function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}
