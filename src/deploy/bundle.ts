/**
 * Shared bundling helpers for the built-in deployment adapters (LOU-I2+).
 *
 * Scaffolded entrypoints (server.ts / worker.ts) import the SDK through a
 * virtual specifier, `@loushy/build-ai-agent/deploy-runtime` (or
 * `.../deploy-runtime-worker`). At build time sdkRuntimePlugin() resolves
 * that specifier to the runtime source file of the SDK copy that is
 * running `loushy build` - so the output is bundled against exactly the
 * SDK version that generated it, and building works from any outDir
 * (including a temp dir with no node_modules of its own).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Plugin } from 'esbuild';

export const RUNTIME_SPECIFIER = '@loushy/build-ai-agent/deploy-runtime';
export const WORKER_RUNTIME_SPECIFIER = '@loushy/build-ai-agent/deploy-runtime-worker';

/**
 * Walks up from this module's directory to the @loushy/build-ai-agent
 * package root. Works both from source (src/deploy/) and from the bundled
 * CLI (dist/cli/build.js), in a checkout or an installed node_modules copy.
 */
function findSdkRoot(startDir: string = __dirname): string {
  let dir = startDir;
  for (;;) {
    if (isSdkPackageRoot(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(
        `loushy build: could not locate the @loushy/build-ai-agent package root above ${startDir}`
      );
    }
    dir = parent;
  }
}

/** True when `dir` holds the readable package.json of @loushy/build-ai-agent. */
function isSdkPackageRoot(dir: string): boolean {
  const pkgPath = path.join(dir, 'package.json');
  if (!fs.existsSync(pkgPath)) return false;
  try {
    return JSON.parse(fs.readFileSync(pkgPath, 'utf8')).name === '@loushy/build-ai-agent';
  } catch {
    // not a readable package.json - keep walking up
    return false;
  }
}

function runtimeSourceFile(fileName: string): string {
  const file = path.join(findSdkRoot(), 'src', 'deploy', fileName);
  if (!fs.existsSync(file)) {
    throw new Error(`loushy build: SDK deploy runtime source not found at ${file}`);
  }
  return file;
}

/** esbuild plugin mapping the virtual runtime specifiers to the SDK's runtime sources. */
export function sdkRuntimePlugin(): Plugin {
  return {
    name: 'loushy-deploy-runtime',
    setup(build) {
      build.onResolve({ filter: /^@loushy\/build-ai-agent\/deploy-runtime(-worker)?$/ }, (args) => ({
        path: runtimeSourceFile(
          args.path === WORKER_RUNTIME_SPECIFIER ? 'runtime.worker.ts' : 'runtime.ts'
        ),
      }));
      // An agent directory's own `import ... from '@loushy/build-ai-agent'` bundles this SDK copy
      // (the one the runtime above comes from), so tools, schedules and channels share its classes.
      build.onResolve({ filter: /^@loushy\/build-ai-agent$/ }, () => ({
        path: path.join(findSdkRoot(), 'src', 'index.ts'),
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
    name: 'loushy-worker-sandbox-shim',
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
    name: 'loushy-worker-node-shim',
    setup(build) {
      build.onResolve({ filter: /^node:|^@modelcontextprotocol\/sdk\/client\/stdio\.js$/ }, (args) => (shimmed(args.importer) ? { path: shim } : undefined));
    },
  };
}

/**
 * Loads tsup lazily: it is only needed by `loushy build`, so the SDK's
 * normal runtime entrypoints never import it.
 */
export async function loadTsup(): Promise<typeof import('tsup')> {
  try {
    return await import('tsup');
  } catch (error) {
    throw new Error(
      `loushy build: the 'tsup' package is required to build deployment targets. ` +
        `Install it with \`npm install --save-dev tsup\`. (${(error as Error).message})`
    );
  }
}

export function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}
