import { AsyncLocalStorage } from 'node:async_hooks';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SDKError } from '../utils/sdkError';

const cacheBust = new AsyncLocalStorage<string>();

/**
 * Runs `fn` so every file `importModule()` loads inside it is imported with a
 * `?t=<token>` query: a fresh module instance instead of the cached one
 * (`lousho dev` hot reload, LOU-D31). Only the file itself is re-evaluated;
 * modules it imports stay cached by the runtime. A CommonJS file (`.cjs`, or
 * `.js` in a package without `"type": "module"`) is cached by file name, which
 * ignores the query, so it is also dropped from `require.cache` first.
 */
export function withFreshImports<T>(token: string, fn: () => Promise<T>): Promise<T> {
  return cacheBust.run(token, fn);
}

/** Node error codes that mean "this process cannot load a TypeScript file". */
const NO_TS_LOADER_CODES = new Set(['ERR_UNKNOWN_FILE_EXTENSION']);

const TS_FILE = /\.[cm]?ts$/;

/**
 * Turns a failed `import()` into an error that names the file and, for a
 * `.ts` file in a process with no TypeScript loader, says how to fix it.
 */
export function explainImportError(file: string, error: unknown): Error {
  const cause = error as NodeJS.ErrnoException;
  if (TS_FILE.test(file) && cause.code === 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX') {
    // Node strips types itself, but only erasable ones: the process can load TypeScript, just not this syntax.
    return new Error(
      `loadAgentDir: cannot import ${file}: it uses TypeScript syntax that Node's built-in type stripping ` +
        `does not support (${cause.code}), such as an enum, a namespace, constructor parameter properties or ` +
        "'import x = require()'. Rewrite it with erasable syntax (a union type or an 'as const' object instead " +
        "of an enum), or let Node transform it: NODE_OPTIONS=--experimental-transform-types (e.g. " +
        "'NODE_OPTIONS=--experimental-transform-types npx lousho chat <dir>'), or compile the file to JavaScript.",
      { cause: error }
    );
  }
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
  const message = `loadAgentDir: failed to import ${file}: ${cause.message ?? String(error)}`;
  const missing = missingPackage(cause);
  if (missing !== undefined) {
    // Typically a kit installed (lousho add) into a folder with no node_modules
    // above it: Node resolves a bare import from the importing file's folder up.
    return new SDKError(message, 'LOUSHO_AGENT_DIR_INVALID', {
      cause: error,
      hint:
        `Node resolves '${missing}' from node_modules in the folder of ${file} or one of its parents, and found none. ` +
        `Install it in the project that contains the agent directory (npm install ${missing}), or move the agent directory inside a project that has it installed.`,
    });
  }
  return new SDKError(message, 'LOUSHO_AGENT_DIR_INVALID', { cause: error });
}

/** The bare package name a "module not found" import error is about, or undefined (also for a missing relative file). */
function missingPackage(cause: NodeJS.ErrnoException): string | undefined {
  if (cause.code !== 'ERR_MODULE_NOT_FOUND' && cause.code !== 'MODULE_NOT_FOUND') return undefined;
  const specifier = /Cannot find (?:module|package) '([^']+)'/.exec(cause.message ?? '')?.[1];
  if (specifier === undefined || /^(?:\.|\/|[A-Za-z]:[\\/]|file:)/.test(specifier)) return undefined;
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/**
 * Drops `files` from Node's CommonJS module cache, so the next `require` or
 * `import()` of each evaluates it again. Files that were never loaded as
 * CommonJS are ignored.
 */
export function forgetCommonJsModules(files: readonly string[]): void {
  if (files.length === 0) return;
  const cache = createRequire(path.resolve(files[0])).cache;
  for (const file of files) {
    const resolved = path.resolve(file);
    delete cache[resolved];
    // The cache is keyed by real path; the agent directory may sit behind a symlink.
    try {
      delete cache[realpathSync(resolved)];
    } catch {
      // A deleted file: nothing more to forget.
    }
  }
}

/** Dynamically imports a user file, with path-bearing errors (see {@link explainImportError}). */
export async function importModule(file: string): Promise<Record<string, unknown>> {
  try {
    const token = cacheBust.getStore();
    if (token !== undefined) forgetCommonJsModules([file]);
    const href = pathToFileURL(file).href;
    return (await import(token === undefined ? href : `${href}?t=${token}`)) as Record<string, unknown>;
  } catch (error) {
    throw explainImportError(file, error);
  }
}
