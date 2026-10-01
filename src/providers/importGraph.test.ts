/**
 * Import-graph test (LOU-D10, LOU-D19): importing a built entry point must
 * not load any optional peer or heavy optional dependency. They are loaded on
 * first use instead, so a missing one cannot break `import`.
 *
 * Needs `dist/` (`npm run build`), like the other dist-dependent tests; CI
 * builds before running tests.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const NEVER_LOADED_AT_IMPORT = [
  '@ai-sdk/openai',
  '@ai-sdk/anthropic',
  'ollama-ai-provider',
  'undici',
  'dockerode',
  '@modelcontextprotocol/sdk',
  'prompts', // LOU-D40: only `loushy init`'s interactive questions use it, on first ask
  'react', // LOU-P2: only the ./react and ./vue subpaths import their framework, no other entry
  'vue',
  'node:sqlite', // LOU-W5: only the lazily-loaded /sqlite subpath may use it, and only when a store is constructed
];

const ENTRY_POINTS = ['index', 'core/index', 'tools/index', 'tools/mcp/index', 'flows/index', 'testing/index', 'storage/sqlite/index'];

/** LOU-P2: the UI binding entries import their own framework (react / vue) and not the other one. */
const OTHER_FRAMEWORK: Record<string, string> = { 'react/index': 'vue', 'vue/index': 'react' };

/** Records every module specifier resolved while `body` runs, via synchronous module hooks. */
const RECORDER = `
const { registerHooks } = require('node:module');
globalThis.__requested = new Set();
registerHooks({
  resolve(specifier, context, nextResolve) {
    globalThis.__requested.add(specifier);
    return nextResolve(specifier, context);
  },
});
`;

function requestedBySpecifier(format: 'cjs' | 'esm', entry: string): string[] {
  const extension = format === 'cjs' ? 'js' : 'mjs';
  const file = path.join(REPO_ROOT, 'dist', `${entry}.${extension}`);
  const load = format === 'cjs' ? `require(${JSON.stringify(file)});` : `await import(${JSON.stringify('file:///' + file.replace(/\\/g, '/'))});`;
  const script = `${RECORDER}\n(async () => { ${load} console.log(JSON.stringify([...globalThis.__requested])); })();`;
  const output = execFileSync(process.execPath, ['-e', script], { cwd: REPO_ROOT, encoding: 'utf8' });
  return JSON.parse(output.trim().split('\n').pop() as string) as string[];
}

function loadedForbidden(requested: string[]): string[] {
  return NEVER_LOADED_AT_IMPORT.filter((pkg) =>
    requested.some((specifier) => specifier === pkg || specifier.startsWith(`${pkg}/`))
  );
}

describe('built entry points load no optional peer at import time', () => {
  for (const format of ['cjs', 'esm'] as const) {
    for (const entry of ENTRY_POINTS) {
      it(`dist/${entry}.${format === 'cjs' ? 'js' : 'mjs'}`, () => {
        const requested = requestedBySpecifier(format, entry);
        expect(requested.length).toBeGreaterThan(0); // the hook really saw the entry load
        expect(loadedForbidden(requested)).toEqual([]);
      });
    }
  }
});

describe('UI binding entries load only their own framework (LOU-P2)', () => {
  for (const format of ['cjs', 'esm'] as const) {
    for (const [entry, other] of Object.entries(OTHER_FRAMEWORK)) {
      it(`dist/${entry}.${format === 'cjs' ? 'js' : 'mjs'} does not load ${other}`, () => {
        const requested = requestedBySpecifier(format, entry);
        expect(requested.some((specifier) => specifier === other || specifier.startsWith(`${other}/`))).toBe(false);
      });
    }
  }
});
