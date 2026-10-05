/**
 * Lazy loading of optional packages (LOU-D10, LOU-D19).
 *
 * Importing the SDK never loads a provider SDK: each is imported with a
 * dynamic `import()` on first use, and a missing package becomes a
 * {@link MissingPeerDependencyError} with the exact install command.
 *
 * LOU-D40 extends this to the feature peers (`dockerode`, the MCP SDK and
 * `prompts`): each is described in {@link FEATURE_PEERS}, so its error also
 * names the feature that needs it.
 */

import { type AiMajor, findPeerPairing, peerInstallCommand } from './providerSpec';
import { SDKError } from '../execution/errors';

/** An optional peer that enables one SDK feature rather than one LLM provider. */
export interface FeaturePeer {
  /** The `peerDependencies` range; a test keeps it equal to package.json. */
  range: string;
  /** What needs the package, as it reads in the error: "<feature> needs it". */
  feature: string;
}

/**
 * The optional peers behind SDK features (not providers; those live in
 * providerSpec.ts). Also what `lousho doctor` lists as "what it enables".
 */
export const FEATURE_PEERS: Readonly<Record<string, FeaturePeer>> = {
  dockerode: { range: '^5.0.1', feature: 'Docker sandboxing (SubprocessSandbox)' },
  '@modelcontextprotocol/sdk': {
    range: '^1.30.1',
    feature: 'MCP (serveMcp, `lousho mcp` and MCP client connections)',
  },
  prompts: {
    range: '^2.4.2',
    feature: 'the interactive prompts of `lousho init` (pass --yes to skip them)',
  },
  'quickjs-emscripten': { range: '^0.32.0', feature: 'code mode (`createAgent({ codeMode })`)' },
  '@earendil-works/pi-ai': {
    range: '1.0.3',
    feature: "the 'pi' provider (`pi/<provider>/<model>` specs, e.g. pi/openrouter/openai/gpt-4o-mini)",
  },
};

function installCommandFor(packageName: string, aiMajor: AiMajor | undefined): string {
  const peer = FEATURE_PEERS[packageName];
  if (peer) return `npm install ${packageName}@${peer.range}`;
  return aiMajor ? peerInstallCommand(packageName, aiMajor) : `npm install ${packageName}`;
}

/**
 * Thrown on first use of a feature whose optional package is not installed.
 *
 * @example
 * ```ts
 * try {
 *   await provider.generate({ messages });
 * } catch (error) {
 *   if (error instanceof MissingPeerDependencyError) console.error(error.installCommand);
 * }
 * ```
 */
export class MissingPeerDependencyError extends SDKError {
  readonly name = 'MissingPeerDependencyError';

  constructor(
    /** The npm package that could not be loaded, e.g. `@ai-sdk/openai`. */
    readonly packageName: string,
    /** The command that installs it, e.g. `npm install @ai-sdk/openai@^0.0.42`. */
    readonly installCommand: string,
    options?: { cause?: unknown; feature?: string; note?: string }
  ) {
    super(
      `The optional package '${packageName}' is not installed, but ${options?.feature ?? 'this feature'} needs it. Run: ${installCommand}` +
        (options?.note ? ` (note: ${options.note})` : ''),
      'LOUSHO_PEER_MISSING',
      { cause: options?.cause }
    );
    this.feature = options?.feature;
  }

  /** The feature that needs the package, when known (every feature peer; not provider peers). */
  readonly feature?: string;
}

/**
 * True when `error` (or an error it wraps as `cause`, as test runners and
 * loaders do) says `packageName` itself could not be resolved (CommonJS or ESM).
 */
function isMissingPackage(error: unknown, packageName: string): boolean {
  const { code, message, cause } = (error ?? {}) as { code?: unknown; message?: unknown; cause?: unknown };
  const text = typeof message === 'string' ? message : '';
  const notFound = code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND' || /cannot find (module|package)/i.test(text);
  // A missing *transitive* module is a broken install, not a missing peer: report it as is.
  if (notFound && text.includes(packageName)) return true;
  return cause !== undefined && cause !== error && isMissingPackage(cause, packageName);
}

/**
 * Run `importer` (which must contain a literal `import('<packageName>')` so
 * bundlers keep it external) and translate "package not found" into a
 * {@link MissingPeerDependencyError}. Other errors are rethrown unchanged.
 * Provider packages pass the installed `aiMajor`, so the hint names the
 * version that pairs with it (LOU-D28d).
 */
export async function loadOptionalPeer<T>(packageName: string, importer: () => Promise<T>, aiMajor?: AiMajor): Promise<T> {
  try {
    return await importer();
  } catch (error) {
    if (!isMissingPackage(error, packageName)) throw error;
    throw new MissingPeerDependencyError(packageName, installCommandFor(packageName, aiMajor), {
      cause: error,
      feature: FEATURE_PEERS[packageName]?.feature,
      note: aiMajor ? findPeerPairing(packageName, aiMajor)?.note : undefined,
    });
  }
}

/**
 * Run `init` once, on first call, and share the result. A failed attempt is
 * not cached, so installing the missing package and retrying works.
 */
export function lazyValue<T>(init: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => {
    pending ??= init().catch((error: unknown) => {
      pending = undefined;
      throw error;
    });
    return pending;
  };
}
