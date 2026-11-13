// @vitest-environment node
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('.', import.meta.url));
const PACKAGE = join(SRC, '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

const SPECIFIER = /(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

function specifiers(file: string): string[] {
  return [...readFileSync(file, 'utf8').matchAll(SPECIFIER)].map((match) => match[1] ?? match[2]);
}

describe('@lousho/workspaces-react package', () => {
  it('there is no dangerouslySetInnerHTML in the package', () => {
    const files = sourceFiles(SRC);
    expect(files.length).toBeGreaterThan(8);
    for (const file of files) expect(readFileSync(file, 'utf8'), file).not.toMatch(/dangerouslySetInnerHTML|\.innerHTML|outerHTML|insertAdjacentHTML|\beval\s*\(|new Function\s*\(/);
  });

  it('the package has no import from apps/agent-forge or node:', () => {
    const builtins = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);
    const all = sourceFiles(SRC).flatMap(specifiers);
    expect(all.length).toBeGreaterThan(10);
    expect(all.filter((specifier) => specifier.startsWith('node:') || builtins.has(specifier) || specifier.includes('agent-forge') || specifier === 'next' || specifier.startsWith('next/'))).toEqual([]);
    const manifest = JSON.parse(readFileSync(join(PACKAGE, 'package.json'), 'utf8')) as Record<string, Record<string, string> | undefined>;
    const names = Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies, ...manifest.devDependencies });
    expect(names.filter((name) => name.includes('agent-forge') || name === 'next')).toEqual([]);
  });
});
