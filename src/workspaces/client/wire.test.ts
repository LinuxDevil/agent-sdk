import { builtinModules } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { generateWireFixtures } from './__fixtures__/generate';
import fixtures from './__fixtures__/wire.fixtures.json';
import { ROUTE_NAMES, WORKSPACE_ROUTES, buildRoutePath } from './wire';
import { wireRunEventSchema } from './wireSchemas';

const HERE = dirname(fileURLToPath(import.meta.url));

const responses = fixtures.responses as Record<string, unknown>;

const IMPORT = /^\s*(?:import|export)\s+(?!type\b)[^;]*?from\s+'([^']+)'|^\s*import\s+'([^']+)'/gms;

function valueImports(file: string): string[] {
  return [...readFileSync(file, 'utf8').matchAll(IMPORT)].map((match) => match[1] ?? match[2]);
}

function resolveImport(from: string, specifier: string): string | undefined {
  const base = resolve(dirname(from), specifier);
  return [base, `${base}.ts`, join(base, 'index.ts')].find((candidate) => /\.(ts|json)$/.test(candidate) && existsSync(candidate));
}

function reachable(entry: string): { files: Set<string>; bare: Set<string> } {
  const files = new Set<string>();
  const bare = new Set<string>();
  const visit = (file: string): void => {
    if (files.has(file)) return;
    files.add(file);
    if (file.endsWith('.json')) return;
    for (const specifier of valueImports(file)) {
      if (!specifier.startsWith('.')) bare.add(specifier);
      else {
        const next = resolveImport(file, specifier);
        if (next !== undefined) visit(next);
      }
    }
  };
  visit(entry);
  return { files, bare };
}

interface BodyParser {
  safeParse(value: unknown): { success: boolean; error?: { issues: { path: PropertyKey[] }[] } };
}

describe('workspace wire contract', () => {
  it('fixtures regenerate byte-identically', () => {
    expect(generateWireFixtures()).toBe(readFileSync(join(HERE, '__fixtures__', 'wire.fixtures.json'), 'utf8'));
  });

  it('every WORKSPACE_ROUTES entry has a fixture response', () => {
    for (const name of ROUTE_NAMES) {
      expect(responses, name).toHaveProperty(name);
      const route = WORKSPACE_ROUTES[name];
      const sample = route.stream === true ? (responses[name] as unknown[])[0] : responses[name];
      expect(route.response.safeParse(sample).success, name).toBe(true);
    }
    expect(Object.keys(responses).sort()).toEqual([...ROUTE_NAMES].sort());
  });

  it('the streamed fixture is a gap-free event log that ends with finished', () => {
    const events = (responses.streamRunEvents as unknown[]).map((event) => wireRunEventSchema.parse(event));
    expect(events.map((event) => event.id)).toEqual(events.map((_event, index) => index));
    expect(events.at(-1)?.event.type).toBe('finished');
  });

  it('every write route requires expectedRevision', () => {
    const writes = ROUTE_NAMES.filter((name) => WORKSPACE_ROUTES[name].effect === 'write');
    expect(writes.length).toBeGreaterThan(8);
    for (const name of writes) {
      const body = WORKSPACE_ROUTES[name].body as BodyParser | undefined;
      expect(body, name).toBeDefined();
      const result = body?.safeParse({});
      expect(result?.success, name).toBe(false);
      expect(result?.error?.issues.some((issue) => issue.path[0] === 'expectedRevision'), name).toBe(true);
    }
  });

  it('only GET routes read, and every other route is a write or a run', () => {
    for (const name of ROUTE_NAMES) {
      const route = WORKSPACE_ROUTES[name];
      if (route.method !== 'GET') expect(route.effect, name).not.toBe('read');
      if (route.effect === 'read') expect(route.method, name).toBe('GET');
    }
  });

  it('route paths are unique per method and fill their parameters encoded', () => {
    const keys = ROUTE_NAMES.map((name) => `${WORKSPACE_ROUTES[name].method} ${WORKSPACE_ROUTES[name].path}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(buildRoutePath('/api/workspaces/:id/artifacts/:runId/:name', { id: 'marketing', runId: 'run-1', name: 'a b/c.md' })).toBe('/api/workspaces/marketing/artifacts/run-1/a%20b%2Fc.md');
  });

  it('the client subpath has no node: imports', () => {
    const { files, bare } = reachable(join(HERE, 'index.ts'));
    expect(files.size).toBeGreaterThan(20);
    const builtins = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);
    expect([...bare].filter((specifier) => specifier.startsWith('node:') || builtins.has(specifier))).toEqual([]);
    expect([...files].filter((file) => file.includes('/__fixtures__/generate'))).toEqual([]);
  });
});
