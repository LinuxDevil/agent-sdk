/**
 * Evaluating one file of an agent directory at build time (cloudflare-worker
 * target, #298). `wrangler.toml` needs a `schedules/` file's cron expression
 * at scaffold time, but the file can be TypeScript and import
 * `@lousho/build-ai-agent`, so plain `import()` cannot load it: this bundles
 * the file with esbuild (the same Worker-SDK mapping the real bundle gets)
 * and imports the result as a `data:` module.
 *
 * Node-only (`lousho build`); nothing here reaches a Worker bundle.
 */
import { SDKError } from '../execution/errors';
import { sdkRuntimePlugin, workerUnsupportedPeerPlugin } from './bundle';
import { explainWorkerBuildError } from './workerSdkExports';

/** esbuild, lazily: like tsup, only `lousho build` needs it (it comes with tsup). */
async function loadEsbuild(): Promise<typeof import('esbuild')> {
  try {
    return await import('esbuild');
  } catch (error) {
    throw new SDKError(
      `lousho build: the 'esbuild' package is required to build deployment targets. ` +
        `Install it with \`npm install --save-dev tsup\` (tsup brings esbuild). (${(error as Error).message})`,
      'LOUSHO_DEPLOY_FAILED'
    );
  }
}

/**
 * Bundles `file` (TypeScript or JavaScript, its own relative imports and
 * `node_modules` resolved) into one ES module and imports it, returning its
 * namespace. `@lousho/build-ai-agent` resolves to the Worker-safe subset
 * (src/deploy/workerSdk.ts) - the same names the final Worker bundle allows,
 * so a file that imports anything else fails here with the build's message.
 * Runs on Node, so `node:` imports inside the file work here even though the
 * Worker bundle would reject them later.
 */
export async function evalModule(file: string): Promise<Record<string, unknown>> {
  const esbuild = await loadEsbuild();
  const result = await esbuild
    .build({
      entryPoints: [file],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'neutral',
      target: 'es2022',
      logLevel: 'silent',
      plugins: [sdkRuntimePlugin({ sdkEntry: 'worker' }), workerUnsupportedPeerPlugin()],
    })
    .catch((error: unknown) => {
      throw explainWorkerBuildError(error);
    });
  const code = result.outputFiles[0]?.text ?? '';
  try {
    return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)) as Record<string, unknown>;
  } catch (error) {
    throw new SDKError(`lousho build: cannot evaluate ${file}: ${(error as Error).message}`, 'LOUSHO_DEPLOY_FAILED', { cause: error });
  }
}
