/**
 * Deployment adapters (LOU-I1).
 *
 * A DeploymentAdapter turns an agent config into a deployable artifact for
 * one target platform (a plain Node http server, a Cloudflare Worker, a
 * Docker image, ...). `lousho build --target=<name> --agent=<path>` looks the
 * adapter up by name in the registry below and drives it through a fixed
 * lifecycle: scaffold() -> build() -> describe().
 */

/** Options a caller of `scaffold()` can pass to a target (LOU-D14). */
export interface DeployOptions {
  /**
   * Bearer auth of the node-server and docker targets: `token` is baked into
   * the built server and used when `LOUSHO_API_TOKEN` is not set at run time.
   * Prefer the environment variable: a baked token is readable in `dist/server.js`.
   */
  auth?: { token?: string };
}

export interface DeploymentAdapter {
  /**
   * Writes the target's source files (entrypoint, config, platform manifest)
   * for the agent config at `agentPath` into `outDir`. `options` apply to the
   * targets that support them (see {@link DeployOptions}).
   */
  scaffold(agentPath: string, outDir: string, options?: DeployOptions): Promise<void>;
  /** Compiles/bundles the scaffolded sources in `outDir` into a deployable artifact. */
  build(outDir: string): Promise<void>;
  /** Returns the command a user runs (from `outDir`) to start/deploy the built artifact. */
  describe(outDir: string): string;
}

const adapters = new Map<string, DeploymentAdapter>();

/**
 * Registers (or replaces) the adapter for `name`. Like
 * LLMProviderRegistry.register(), this is a plain Map.set() - registering
 * the same name twice silently overwrites rather than throwing.
 */
export function registerAdapter(name: string, adapter: DeploymentAdapter): void {
  adapters.set(name, adapter);
}

/** Returns the adapter registered under `name`, or undefined if there is none. */
export function getAdapter(name: string): DeploymentAdapter | undefined {
  return adapters.get(name);
}

/** Names of every registered adapter, in registration order. */
export function listAdapters(): string[] {
  return Array.from(adapters.keys());
}
