/**
 * Worker-safe stand-in for the optional peer `isolated-vm`.
 *
 * The cloudflare-worker adapter's build redirects the SDK's import of
 * `isolated-vm` (the 'isolate' sandbox driver's V8 isolate) here, so a
 * Worker bundle never carries the native addon, which cannot run outside a
 * Node process anyway. A `sandbox({ driver: 'isolate' })` run - or a
 * `defineTool({ sandbox })` call - fails on first use with this error.
 * The Isolate export must exist for `new module.Isolate(...)` to fail
 * cleanly rather than with a confusing "not a constructor".
 */
import { SDKError } from '../../execution/errors';

export class Isolate {
  constructor() {
    throw new SDKError(
      "The 'isolate' sandbox driver is not supported on the cloudflare-worker target: isolated-vm is a Node-only native module that is not bundled into Workers. Pass another SandboxDriver, or run the tool without a sandbox.",
      'LOUSHO_DEPLOY_FAILED'
    );
  }
}
