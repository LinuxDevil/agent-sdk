/**
 * Logger
 * A minimal, pluggable logging interface (LOU-E7) that internal modules
 * (providers, retry.ts, ...) can accept instead of calling console.*
 * directly, so a consuming application can route SDK log output wherever
 * it wants. See LOU-E8 for wiring this into OllamaProvider,
 * OpenRouterProvider and retry.ts.
 */

/**
 * A pluggable logger. Each level takes a message plus an optional
 * structured `meta` object for interpolated values, instead of a
 * pre-formatted, string-concatenated message.
 */
export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

/**
 * A Logger whose every method is a no-op. The default for any code that
 * accepts an optional `logger: Logger = noopLogger` parameter, so SDK
 * consumers who don't care about log output see none by default (and
 * definitely no console.* calls from inside the SDK).
 */
export const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
