/**
 * LOU-D2.3: user-reachable failures throw an `SDKError` with a registered code
 * (docs/errors.md). This guard scans the non-test source for `throw new Error(`
 * so new plain Errors do not creep back in.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const SRC = resolve(__dirname, '..');

/** The plain Errors that stay, as `file` + the start of the message, each with why. */
const ALLOWED: Array<{ file: string; message: string; reason: string }> = [
  {
    file: 'deploy/shims/node.worker.ts',
    message: "'This feature needs Node.js",
    reason: 'a stub bundled into the Cloudflare Worker in place of node:* modules; it must not import SDK modules',
  },
  {
    file: 'deploy/shims/sandboxCore.worker.ts',
    message: "'Sandboxed tool execution is not supported",
    reason: 'a stub bundled into the Cloudflare Worker in place of the sandbox; it must not import SDK modules',
  },
  {
    file: 'flows/FlowExecutor.ts',
    message: "this.interpolate(node.message || 'Flow error'",
    reason: "the flow's own `throw` node: it surfaces the flow author's message verbatim, and a span's error.type stays 'Error'",
  },
  {
    file: 'security/docker.testkit.ts',
    message: "'LOUSHO_DOCKER_TESTS=1 is set",
    reason: 'a test helper (never bundled or exported): it fails the Docker CI suite when no daemon answers',
  },
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__fixtures__' ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test(-d)?\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/** `file` (relative to src, with `/`) and the text after `throw new Error(` of each real throw (comments skipped). */
function plainThrows(): Array<{ file: string; rest: string }> {
  return sourceFiles(SRC).flatMap((path) => {
    const file = relative(SRC, path).replace(/\\/g, '/');
    const lines = readFileSync(path, 'utf8').split(/\r?\n/);
    return lines.flatMap((line, index) => {
      const at = line.indexOf('throw new Error(');
      if (at === -1 || /^\s*(\*|\/\/)/.test(line)) return [];
      const rest = line.slice(at + 'throw new Error('.length).trim() || (lines[index + 1] ?? '').trim();
      return [{ file, rest }];
    });
  });
}

describe('plain Errors (LOU-D2.3)', () => {
  const found = plainThrows();
  const isAllowed = (site: { file: string; rest: string }) =>
    ALLOWED.some((entry) => entry.file === site.file && site.rest.startsWith(entry.message));

  it('no new `throw new Error(` in src: use SDKError, or add the site to ALLOWED with a reason', () => {
    const unexpected = found.filter((site) => !isAllowed(site)).map((site) => `${site.file}: ${site.rest.slice(0, 60)}`);
    expect(
      unexpected,
      "Throw an SDKError with a registered code (src/utils/errorCodes.ts, docs/errors.md), or toolFailure() for a tool's run-time failure. " +
        'If this is an internal invariant that users cannot reach, add it to ALLOWED in src/utils/plainErrors.test.ts with the reason.'
    ).toEqual([]);
  });

  it('every allowlist entry still matches a site, so the list does not rot', () => {
    const stale = ALLOWED.filter((entry) => !found.some((site) => site.file === entry.file && site.rest.startsWith(entry.message)));
    expect(stale.map((entry) => `${entry.file}: ${entry.message}`)).toEqual([]);
    for (const entry of ALLOWED) expect(entry.reason.length).toBeGreaterThan(10);
  });
});
