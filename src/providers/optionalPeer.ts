/**
 * Lazy loading of optional packages (LOU-D10, LOU-D19).
 *
 * Importing the SDK never loads a provider SDK: each is imported with a
 * dynamic `import()` on first use, and a missing package becomes a
 * {@link MissingPeerDependencyError} with the exact install command.
 */

import { peerInstallCommand } from './providerSpec';

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
export class MissingPeerDependencyError extends Error {
  readonly name = 'MissingPeerDependencyError';

  constructor(
    /** The npm package that could not be loaded, e.g. `@ai-sdk/openai`. */
    readonly packageName: string,
    /** The command that installs it, e.g. `npm install @ai-sdk/openai@^0.0.42`. */
    readonly installCommand: string,
    options?: { cause?: unknown }
  ) {
    super(
      `The optional package '${packageName}' is not installed, but this feature needs it. Run: ${installCommand}`,
      options
    );
  }
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
 */
export async function loadOptionalPeer<T>(packageName: string, importer: () => Promise<T>): Promise<T> {
  try {
    return await importer();
  } catch (error) {
    if (!isMissingPackage(error, packageName)) throw error;
    throw new MissingPeerDependencyError(packageName, peerInstallCommand(packageName), { cause: error });
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
