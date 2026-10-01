import { AsyncLocalStorage } from 'node:async_hooks';
import { pathToFileURL } from 'node:url';

const cacheBust = new AsyncLocalStorage<string>();

/**
 * Runs `fn` so every file `importModule()` loads inside it is imported with a
 * `?t=<token>` query: a fresh module instance instead of the cached one
 * (`loushy dev` hot reload, LOU-D31). Only the file itself is re-evaluated;
 * modules it imports stay cached by the runtime.
 */
export function withFreshImports<T>(token: string, fn: () => Promise<T>): Promise<T> {
  return cacheBust.run(token, fn);
}

/** Node error codes that mean "this process cannot load a TypeScript file". */
const NO_TS_LOADER_CODES = new Set(['ERR_UNKNOWN_FILE_EXTENSION', 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX']);

const TS_FILE = /\.[cm]?ts$/;

/**
 * Turns a failed `import()` into an error that names the file and, for a
 * `.ts` file in a process with no TypeScript loader, says how to fix it.
 */
export function explainImportError(file: string, error: unknown): Error {
  const cause = error as NodeJS.ErrnoException;
  if (TS_FILE.test(file) && cause.code !== undefined && NO_TS_LOADER_CODES.has(cause.code)) {
    return new Error(
      `loadAgentDir: cannot import ${file}: this process cannot load TypeScript files (${cause.code}). ` +
        "Run your script under a TypeScript loader, e.g. 'npx tsx your-script.ts' (also works with " +
        "ts-node, bun, deno, or Node's --experimental-strip-types), or compile the agent directory to " +
        'JavaScript first and load the compiled output. Alternatively write this file as .js/.mjs, or ' +
        'use agent.json / agent.yaml for config.',
      { cause: error }
    );
  }
  return new Error(`loadAgentDir: failed to import ${file}: ${cause.message ?? String(error)}`, {
    cause: error,
  });
}

/** Dynamically imports a user file, with path-bearing errors (see {@link explainImportError}). */
export async function importModule(file: string): Promise<Record<string, unknown>> {
  try {
    const token = cacheBust.getStore();
    const href = pathToFileURL(file).href;
    return (await import(token === undefined ? href : `${href}?t=${token}`)) as Record<string, unknown>;
  } catch (error) {
    throw explainImportError(file, error);
  }
}
