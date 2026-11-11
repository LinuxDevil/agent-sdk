import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isZod4Schema } from '../src/utils/zodCompat';
import { workspaceManifestObjectSchema } from '../src/workspaces/contracts/workspace';
import { jsonSchemaToStandardSchema } from '../src/spec/v2/jsonSchemaAdapter';
import { MARKETING_BUILD_OPS } from '../src/workspaces/contracts/__fixtures__/authoringOps';
import { readFixtureTree, readNegativeIndex, readNegativeTree } from '../src/workspaces/__fixtures__/readTree';
import { renderWorkspaceSchemas, workspaceJsonSchemas } from './workspacesSchema';

const SCHEMAS_DIR = path.resolve(__dirname, '..', 'schemas');

const ROUTES: [RegExp, string][] = [
  [/^workspace\.json$/, 'lousho.workspace.v1.json'],
  [/^harness\/harness\.json$/, 'lousho.harness.v1.json'],
  [/^harness-profiles\/.+\/harness\.json$/, 'lousho.harness.v1.json'],
  [/^pages\/[^/]+\/harness\/harness\.json$/, 'lousho.harness.v1.json'],
  [/^pages\/[^/]+\/page\.json$/, 'lousho.page.v1.json'],
  [/^pages\/[^/]+\/agents\.json$/, 'lousho.agents.v1.json'],
  [/^pages\/[^/]+\/ui\/page\.ui\.json$/, 'lousho.ui.v1.json'],
  [/^main-agent\/harness\/main-harness\.json$/, 'lousho.main-harness.v1.json'],
  [/^shared\/policies\/policy\.json$/, 'lousho.policy.v1.json'],
];

const NOT_EXPRESSIBLE = [
  'harness-duplicate-constraint-id',
  'base-harness-has-extends',
  'attachment-duplicate-alias',
  'attachment-ref-no-prefix',
  'page-nested-pages',
];

const REF = /^#\/definitions\/(.+)$/;

function unroll(node: unknown, definitions: Record<string, unknown>, depth: number): unknown {
  if (Array.isArray(node)) return node.map((item) => unroll(item, definitions, depth));
  if (typeof node !== 'object' || node === null) return node;
  const target = REF.exec(String((node as { $ref?: unknown }).$ref ?? ''))?.[1];
  if (target !== undefined) return depth === 0 ? {} : unroll(definitions[target], definitions, depth - 1);
  return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, unroll(value, definitions, depth)]));
}

function unrolled(schema: Record<string, unknown>): Record<string, unknown> {
  const { definitions, ...rest } = schema;
  return unroll(rest, (definitions ?? {}) as Record<string, unknown>, 6) as Record<string, unknown>;
}

function validatorFor(file: string): (value: unknown) => boolean {
  const schema = unrolled(workspaceJsonSchemas()[file]);
  const standard = jsonSchemaToStandardSchema(schema)['~standard'];
  return (value) => {
    const result = standard.validate(value) as { issues?: unknown };
    return result.issues === undefined;
  };
}

function schemaFileOf(filePath: string): string | undefined {
  return ROUTES.find(([pattern]) => pattern.test(filePath))?.[1];
}

describe('exported workspace JSON Schemas', () => {
  it.skipIf(isZod4Schema(workspaceManifestObjectSchema))('are current: schemas/ holds exactly what npm run workspaces:schema writes', () => {
    const rendered = renderWorkspaceSchemas();
    expect(fs.readdirSync(SCHEMAS_DIR).sort()).toEqual(Object.keys(rendered).sort());
    for (const [file, content] of Object.entries(rendered)) {
      expect(fs.readFileSync(path.join(SCHEMAS_DIR, file), 'utf8'), file).toBe(content);
    }
  });

  it('cover workspace, page, harness, main-harness, agents, ui, policy and authoring-ops, and not lock', () => {
    expect(Object.keys(workspaceJsonSchemas()).sort()).toEqual(
      ['workspace', 'page', 'harness', 'main-harness', 'agents', 'ui', 'policy', 'authoring-ops'].map((kind) => `lousho.${kind}.v1.json`).sort()
    );
  });

  it('accept every positive fixture file', () => {
    for (const name of ['marketing', 'ops-desk', 'coding']) {
      for (const [filePath, value] of Object.entries(readFixtureTree(name))) {
        const file = schemaFileOf(filePath);
        if (file !== undefined) expect(validatorFor(file)(value), `${name}/${filePath}`).toBe(true);
      }
    }
  });

  it('accept every authoring operation the Marketing build uses and reject an unknown one', () => {
    const accepts = validatorFor('lousho.authoring-ops.v1.json');
    for (const operation of MARKETING_BUILD_OPS) expect(accepts(operation), operation.op).toBe(true);
    expect(accepts({ op: 'not-an-op' })).toBe(false);
  });

  it('reject every schema-level negative that JSON Schema can express', () => {
    const { cases } = readNegativeIndex();
    const checked: string[] = [];
    for (const item of cases.filter((candidate) => candidate.checkedBy === 'schema')) {
      const file = schemaFileOf(item.file);
      if (file === undefined || NOT_EXPRESSIBLE.includes(item.name)) continue;
      const value = readNegativeTree(item.name)[item.file];
      expect(validatorFor(file)(value), item.name).toBe(false);
      checked.push(item.name);
    }
    expect(checked).toEqual(['harness-permissions', 'harness-execution-key', 'attachment-tools-add', 'page-goal-without-lead', 'ui-html-prop']);
  });

  it('name the schema negatives JSON Schema cannot express: unique ids and aliases, the ref grammar, nested pages and the base-harness shape', () => {
    const { cases } = readNegativeIndex();
    const schemaCases = cases.filter((candidate) => candidate.checkedBy === 'schema').map((candidate) => candidate.name);
    for (const name of NOT_EXPRESSIBLE) expect(schemaCases).toContain(name);
    for (const item of cases.filter((candidate) => NOT_EXPRESSIBLE.includes(candidate.name))) {
      const file = schemaFileOf(item.file);
      if (file !== undefined) expect(validatorFor(file)(readNegativeTree(item.name)[item.file]), item.name).toBe(true);
    }
  });

  it('give every schema a stable $id that names its file', () => {
    for (const [file, schema] of Object.entries(workspaceJsonSchemas())) expect(schema.$id, file).toBe(`https://lousho.com/schemas/${file}`);
  });

  it('reject a forbidden prop on the root component of a page UI', () => {
    const rejects = (layout: unknown): boolean => !validatorFor('lousho.ui.v1.json')({ schema: 'lousho.ui/1', layout });
    expect(rejects({ type: 'runButton', html: '<b>x</b>' })).toBe(true);
    expect(rejects({ type: 'runButton' })).toBe(false);
  });
});
