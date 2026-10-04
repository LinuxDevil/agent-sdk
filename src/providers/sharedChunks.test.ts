/**
 * Shared-chunk test (LOU-D42): the built entries import shared chunks, so one class or singleton
 * is one object across entries (ESM and CJS), and `instanceof SDKError` / `HookRegistry` also
 * holds across the ESM and CJS copies a mixed-format process loads (the dual-package hazard).
 *
 * Needs `dist/` (`npm run build`), like importGraph.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { SDKError } from '../execution/errors';
import { HookRegistry } from '../execution/hooks';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const dist = (file: string) => JSON.stringify(path.join(REPO_ROOT, 'dist', file));

/** Runs `body` in a fresh Node process (ESM-capable async wrapper) and returns its JSON result. */
function inChild(body: string): Record<string, boolean> {
  const script = `(async () => { const { pathToFileURL } = require('node:url'); const esm = (f) => import(pathToFileURL(f).href); ${body} })().then((r) => console.log(JSON.stringify(r)));`;
  const output = execFileSync(process.execPath, ['-e', script], { cwd: REPO_ROOT, encoding: 'utf8' });
  return JSON.parse(output.trim().split('\n').pop() as string) as Record<string, boolean>;
}

/** Same-object checks across entries: HookRegistry, a module-level registry, and error classes. */
const SAME_OBJECTS = `
  const same = (a, b, key) => a[key] === b[key];
  return {
    hookRegistry: same(root, hooks, 'HookRegistry'),
    toolRegistrySingleton: same(executor, tools, 'globalToolRegistry') && same(executor, tools, 'ToolRegistry'),
    mcpToolError: same(tools, mcp, 'McpToolError') && same(root, mcp, 'McpToolError'),
    sdkErrorInstanceof: new root.AgentExecutionError('x') instanceof root.SDKError,
  };`;

describe('shared chunks across package entries (LOU-D42)', () => {
  it('ESM entries share one copy of each module', () => {
    const result = inChild(
      `const [root, hooks, tools, mcp, executor] = await Promise.all([${['index.mjs', 'execution/hooks.mjs', 'tools/index.mjs', 'tools/mcp/index.mjs', 'executor/index.mjs'].map((f) => `esm(${dist(f)})`).join(',')}]); ${SAME_OBJECTS}`
    );
    expect(result).toEqual({ hookRegistry: true, toolRegistrySingleton: true, mcpToolError: true, sdkErrorInstanceof: true });
  });

  it('CJS entries share one copy of each module', () => {
    const result = inChild(
      `const [root, hooks, tools, mcp, executor] = [${['index.js', 'execution/hooks.js', 'tools/index.js', 'tools/mcp/index.js', 'executor/index.js'].map((f) => `require(${dist(f)})`).join(',')}]; ${SAME_OBJECTS}`
    );
    expect(result).toEqual({ hookRegistry: true, toolRegistrySingleton: true, mcpToolError: true, sdkErrorInstanceof: true });
  });

  it('instanceof works across the ESM and CJS copies a mixed process loads', () => {
    const result = inChild(`
      const esmRoot = await esm(${dist('index.mjs')});
      const cjsRoot = require(${dist('index.js')});
      return {
        distinctCopies: esmRoot.SDKError !== cjsRoot.SDKError,
        sdkError: new esmRoot.SDKError('x') instanceof cjsRoot.SDKError,
        hookRegistry: new esmRoot.HookRegistry() instanceof cjsRoot.HookRegistry,
        subclassNotConfused: new esmRoot.SDKError('x') instanceof cjsRoot.AgentExecutionError === false,
      };`);
    expect(result).toEqual({ distinctCopies: true, sdkError: true, hookRegistry: true, subclassNotConfused: true });
  });

  it('brands answer instanceof for foreign-copy objects but not for unrelated ones', () => {
    expect(Object.create({ [Symbol.for('lousho.SDKError')]: true })).toBeInstanceOf(SDKError);
    expect(Object.create({ [Symbol.for('lousho.HookRegistry')]: true })).toBeInstanceOf(HookRegistry);
    expect(new Error('x')).not.toBeInstanceOf(SDKError);
    expect({}).not.toBeInstanceOf(HookRegistry);
    expect((null as unknown as object) instanceof SDKError).toBe(false);
  });

  it('every package.json exports target exists in dist/', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { exports: Record<string, unknown> };
    const targets: string[] = [];
    const walk = (node: unknown): void => {
      if (typeof node === 'string') targets.push(node);
      else if (node && typeof node === 'object') Object.values(node).forEach(walk);
    };
    walk(pkg.exports);
    expect(targets.length).toBeGreaterThan(20);
    const missing = targets.filter((target) => !target.endsWith('.json') && !fs.existsSync(path.join(REPO_ROOT, target)));
    expect(missing).toEqual([]);
  });
});
