import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { WorkspaceTree } from '../contracts/baseHarness';

const ROOT = fileURLToPath(new URL('.', import.meta.url));

function walk(dir: string, prefix: string): string[] {
  return readdirSync(join(dir, prefix), { withFileTypes: true }).flatMap((entry) => {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    return entry.isDirectory() ? walk(dir, path) : [path];
  });
}

function readFile(dir: string, path: string): unknown {
  const text = readFileSync(join(dir, path), 'utf8');
  return path.endsWith('.json') ? JSON.parse(text) : text;
}

function readDir(dir: string): Record<string, unknown> {
  return Object.fromEntries(walk(dir, '').sort().map((path) => [path, readFile(dir, path)]));
}

export function readFixtureTree(name: string): WorkspaceTree {
  return readDir(join(ROOT, name));
}

export interface NegativeCase {
  name: string;
  checkedBy: 'schema' | 'helper' | 'validateWorkspace';
  file: string;
  expect: string;
}

export function readNegativeIndex(): { base: string; cases: NegativeCase[] } {
  return JSON.parse(readFileSync(join(ROOT, 'negative', 'index.json'), 'utf8'));
}

export function readNegativeTree(name: string, remove: readonly string[] = []): WorkspaceTree {
  const merged = { ...readDir(join(ROOT, 'negative', '_base')), ...readDir(join(ROOT, 'negative', name)) };
  return Object.fromEntries(Object.entries(merged).filter(([path]) => !remove.includes(path)));
}
