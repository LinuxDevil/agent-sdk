import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isZod4Schema } from '../../utils/zodCompat';
import { workspaceManifestObjectSchema } from '../contracts/workspace';
import { NOT_EXPRESSIBLE, committedWorkspaceSchemas, renderWorkspaceSchemas, schemaFileOf, validatorFor } from '../../../scripts/workspacesSchema';
import { readFixtureTree, readNegativeIndex, readNegativeTree } from '../__fixtures__/readTree';
import { applyOps } from '../contracts/authoringOps';
import { composeHarness } from '../contracts/compose';
import { base, instagram, page, profiles, layer } from '../contracts/__fixtures__/composeLayers';
import { MARKETING_BUILD_OPS, NOT_WRITABLE } from '../contracts/__fixtures__/authoringOps';
import { validateWorkspace } from '../contracts/validate';

const POSITIVE = ['marketing', 'ops-desk', 'coding'];

const MARKETING_DIR = fileURLToPath(new URL('../__fixtures__/marketing/', import.meta.url));

const golden = (name: string): string => `../contracts/__fixtures__/compose/${name}.json`;
const asJson = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const rawOf = (path: string): string => readFileSync(join(MARKETING_DIR, path), 'utf8');
const serialized = (value: unknown): string => (typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
const sameText = (built: string, raw: string): boolean => built === raw || `${built}\n` === raw;

describe('G0 contract gate', () => {
  it.each(POSITIVE)('positive fixture %s validates with zero problems', (name) => {
    expect(validateWorkspace(readFixtureTree(name), { mode: 'default' })).toEqual([]);
  });

  it('every negative fixture yields exactly its code, 23 distinct', () => {
    const { cases } = readNegativeIndex();
    expect(new Set(cases.map((item) => item.code)).size).toBe(23);
    for (const item of cases) {
      const codes = [...new Set(validateWorkspace(readNegativeTree(item.name), { mode: 'default' }).map((problem) => problem.code))];
      expect(codes, item.name).toEqual([item.code]);
    }
  });

  it.skipIf(isZod4Schema(workspaceManifestObjectSchema))('the committed schemas/*.v1.json equal the zod-generated schemas', () => {
    const rendered = renderWorkspaceSchemas();
    const committed = committedWorkspaceSchemas();
    expect(Object.keys(committed)).toEqual(Object.keys(rendered).sort());
    for (const [file, content] of Object.entries(rendered)) expect(committed[file], file).toBe(content);
  });

  it('the committed JSON Schemas agree with zod on every fixture file', () => {
    for (const name of POSITIVE) {
      for (const [filePath, value] of Object.entries(readFixtureTree(name))) {
        const file = schemaFileOf(filePath);
        if (file !== undefined) expect(validatorFor(file)(value), `${name}/${filePath}`).toBe(true);
      }
    }
    const schemaCases = readNegativeIndex().cases.filter((item) => item.checkedBy === 'schema' && !NOT_EXPRESSIBLE.includes(item.name));
    expect(schemaCases.length).toBeGreaterThan(0);
    for (const item of schemaCases) {
      const file = schemaFileOf(item.file);
      if (file === undefined) continue;
      expect(validatorFor(file)(readNegativeTree(item.name)[item.file]), item.name).toBe(false);
    }
  });

  it('composeHarness goldens are stable without a base harness', async () => {
    await expect(asJson(composeHarness([...profiles, page]))).toMatchFileSnapshot(golden('instagram-educational-general-page'));
  });

  it('composeHarness goldens are stable with a base harness', async () => {
    const pageOnInstagram = layer('page', { ...page.harness, extends: ['workspace:platforms/instagram'] }, page.texts);
    await expect(asJson(composeHarness([base, instagram, pageOnInstagram]))).toMatchFileSnapshot(golden('base-instagram-page'));
  });

  it('the scripted applyOps sequence rebuilds the Marketing fixture byte for byte', () => {
    const fixture = readFixtureTree('marketing');
    const seed = Object.fromEntries(Object.entries(fixture).filter(([path]) => NOT_WRITABLE.some((pattern) => pattern.test(path))));
    const result = applyOps(seed, MARKETING_BUILD_OPS, { validate: validateWorkspace });
    expect(result.problems).toEqual([]);
    const differing = Object.keys(result.tree).filter((path) => !(path in fixture) || !sameText(serialized(result.tree[path]), rawOf(path)));
    expect(differing).toEqual([]);
    const written = Object.keys(result.tree).filter((path) => !(path in seed));
    expect(written.length).toBeGreaterThan(30);
    const missing = Object.keys(fixture).filter((path) => !(path in result.tree));
    expect(missing).toEqual([]);
  });
});
