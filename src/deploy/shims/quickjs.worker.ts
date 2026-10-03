/**
 * Worker-safe stand-in for the optional peer `quickjs-emscripten` (N14).
 *
 * The cloudflare-worker adapter's build redirects the SDK's import of
 * `quickjs-emscripten` (code mode's isolate) here, so a Worker bundle never
 * carries the Emscripten runtime and its WebAssembly loader, which expects a
 * file system. A run with `codeMode` fails at its start with this error.
 */
import { SDKError } from '../../execution/errors';

export async function newQuickJSWASMModule(): Promise<never> {
  throw new SDKError(
    'Code mode (createAgent({ codeMode })) is not supported on the cloudflare-worker target yet: its QuickJS isolate is not bundled into Workers. Turn codeMode off for this deployment.',
    'LOUSHO_DEPLOY_FAILED'
  );
}
