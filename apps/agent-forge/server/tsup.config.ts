import { defineConfig } from 'tsup';

/**
 * S1 (LOU-S): production build of the LOU-N runtime control server.
 *
 * `server:dev`/`server:start` (LOU-N) run this server straight off its
 * TypeScript source via `tsx`, which is fine for local development but not
 * for a published npm package: a consumer installing `@loushy/build-ai-agent`
 * has neither `tsx` nor this app's devDependencies (vite, vitest, jsdom, ...)
 * available, and shipping raw `.ts` server source that needs a TS loader at
 * runtime would make `loushy studio` depend on tooling nobody asked to
 * install. So this bundles the server into a single, dependency-free-except-
 * one plain ESM `.js` file under `dist-server/`, the same way the SDK's own
 * root `tsup.config.ts` builds `src/**` into `dist/**`.
 *
 * `@loushy/build-ai-agent` itself is left external rather than bundled: at
 * runtime this file always lives inside an install of that very package
 * (either the workspace symlink in this monorepo, or
 * `node_modules/@loushy/build-ai-agent` for anyone who installed the
 * published package), so Node's package self-reference resolution
 * (package.json `name` + `exports`) finds it directly - no need to duplicate
 * the entire SDK's compiled output a second time inside
 * `apps/agent-forge/dist-server`.
 *
 * Everything else this server actually needs at runtime (express, cors, ws)
 * is NOT something a consumer of the *root* package is expected to have
 * installed either (they're `apps/agent-forge`'s own dependencies, and
 * `apps/agent-forge/node_modules` does not ship in the published package -
 * see the root `files` array), so those are force-bundled via `noExternal`
 * instead of tsup's normal default of externalizing anything listed in
 * `package.json` dependencies.
 *
 * `yaml` is the one exception: it's left external (like
 * `@loushy/build-ai-agent`) because the root package already depends on it
 * directly (see the root `package.json`), so it's always available via
 * normal node_modules resolution wherever this server runs - and, more
 * importantly, esbuild's CJS-in-ESM interop for yaml's own bundled build
 * breaks (`Dynamic require of "process" is not supported`) if it's force-
 * bundled here instead of left as a real `require`/`import`.
 */
export default defineConfig({
  entry: { index: 'server/index.ts' },
  outDir: 'dist-server',
  // CJS, not ESM: bundling `express` (and its own dependency `debug`, which
  // does `require('tty')`/`require('util')` conditionally at runtime to
  // detect a TTY) as ESM makes esbuild emit those as its own
  // "dynamic require" shim, which throws for Node builtins
  // (`Dynamic require of "tty" is not supported`) - a known esbuild
  // CJS-bundled-as-ESM interop gap, not something specific to this server.
  // Real CommonJS `require()` (this format) handles it fine. `outExtension`
  // names the output `index.cjs` so Node treats it as CommonJs regardless of
  // `apps/agent-forge/package.json`'s own `"type": "module"` (which only
  // governs plain `.js` files, not `.cjs`).
  format: ['cjs'],
  outExtension: () => ({ js: '.cjs' }),
  platform: 'node',
  target: 'node18',
  dts: false,
  splitting: false,
  sourcemap: true,
  clean: true,
  treeshake: true,
  minify: false,
  external: ['@loushy/build-ai-agent', 'yaml'],
  noExternal: ['express', 'cors', 'ws'],
});
