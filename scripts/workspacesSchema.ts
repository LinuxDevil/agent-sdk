import * as fs from 'node:fs';
import * as path from 'node:path';
import { zodSchema } from 'ai';
import { z } from 'zod';
import { schemaToJsonSchema } from '../src/utils/zodCompat';
import { jsonSchemaToStandardSchema } from '../src/spec/v2/jsonSchemaAdapter';
import { attachmentObjectSchema } from '../src/workspaces/contracts/agentRefs';
import { authoringOpJsonSchema } from '../src/workspaces/contracts/authoringOps';
import { harnessObjectSchema } from '../src/workspaces/contracts/harness';
import { mainHarnessObjectSchema } from '../src/workspaces/contracts/mainHarness';
import { pageObjectSchema } from '../src/workspaces/contracts/page';
import { workspacePolicyObjectSchema } from '../src/workspaces/contracts/policy';
import { pageUiObjectSchema } from '../src/workspaces/contracts/ui';
import { workspaceManifestObjectSchema } from '../src/workspaces/contracts/workspace';

type JsonObject = Record<string, unknown>;

interface WorkspaceSchemaEntry {
  file: string;
  title: string;
  schema: () => JsonObject;
}

const agentsObjectSchema = z.object({ schema: z.literal('lousho.agents/1'), agents: z.array(attachmentObjectSchema) }).strict();

function fromZod(schema: unknown): JsonObject {
  return structuredClone(schemaToJsonSchema(schema) ?? (zodSchema(schema as never).jsonSchema as JsonObject));
}

function stripNestedSchemas(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach(stripNestedSchemas);
    return;
  }
  delete (value as JsonObject).$schema;
  Object.values(value).forEach(stripNestedSchemas);
}

const SCHEMA_ID_BASE = 'https://lousho.com/schemas/';

const COMPONENT_REF = { $ref: '#/definitions/component' };

function isOpenChildren(value: unknown): value is { type: 'array'; items: JsonObject } {
  return typeof value === 'object' && value !== null && (value as JsonObject).type === 'array' && Object.keys((value as JsonObject).items as JsonObject).length === 0;
}

function linkChildren(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach(linkChildren);
    return;
  }
  const node = value as JsonObject;
  if (isOpenChildren(node.children)) node.children.items = { ...COMPONENT_REF };
  Object.values(node).forEach(linkChildren);
}

function uiSchema(): JsonObject {
  const schema = quietly(() => fromZod(pageUiObjectSchema));
  const properties = schema.properties as JsonObject;
  const component = properties.layout;
  linkChildren(component);
  properties.layout = { ...COMPONENT_REF };
  return { ...schema, definitions: { ...(schema.definitions as JsonObject | undefined), component } };
}

function quietly<T>(run: () => T): T {
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    return run();
  } finally {
    console.warn = warn;
  }
}

const ENTRIES: readonly WorkspaceSchemaEntry[] = [
  { file: 'lousho.workspace.v1.json', title: 'lousho.workspace/1', schema: () => fromZod(workspaceManifestObjectSchema) },
  { file: 'lousho.page.v1.json', title: 'lousho.page/1', schema: () => fromZod(pageObjectSchema) },
  { file: 'lousho.harness.v1.json', title: 'lousho.harness/1', schema: () => fromZod(harnessObjectSchema) },
  { file: 'lousho.main-harness.v1.json', title: 'lousho.main-harness/1', schema: () => fromZod(mainHarnessObjectSchema) },
  { file: 'lousho.agents.v1.json', title: 'lousho.agents/1', schema: () => fromZod(agentsObjectSchema) },
  { file: 'lousho.ui.v1.json', title: 'lousho.ui/1', schema: uiSchema },
  { file: 'lousho.policy.v1.json', title: 'lousho workspace policy', schema: () => fromZod(workspacePolicyObjectSchema) },
  { file: 'lousho.authoring-ops.v1.json', title: 'lousho workspace authoring operation', schema: () => authoringOpJsonSchema() },
];

function build(entry: WorkspaceSchemaEntry): JsonObject {
  const schema = entry.schema();
  stripNestedSchemas(schema);
  return { $schema: 'http://json-schema.org/draft-07/schema#', $id: `${SCHEMA_ID_BASE}${entry.file}`, title: entry.title, ...schema };
}

/** The exported workspace JSON Schemas by file name (`lousho.<kind>.v1.json`), as plain objects. */
export function workspaceJsonSchemas(): Record<string, JsonObject> {
  return Object.fromEntries(ENTRIES.map((entry) => [entry.file, build(entry)]));
}

/** The exported workspace JSON Schemas by file name, as the exact text `npm run workspaces:schema` writes. */
export function renderWorkspaceSchemas(): Record<string, string> {
  return Object.fromEntries(Object.entries(workspaceJsonSchemas()).map(([file, schema]) => [file, `${JSON.stringify(schema, null, 2)}\n`]));
}

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

export const NOT_EXPRESSIBLE = [
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

const SCHEMAS_DIR = path.resolve(__dirname, '..', 'schemas');

export function committedWorkspaceSchemas(): Record<string, string> {
  return Object.fromEntries(fs.readdirSync(SCHEMAS_DIR).sort().map((file) => [file, fs.readFileSync(path.join(SCHEMAS_DIR, file), 'utf8')]));
}

export function validatorFor(file: string): (value: unknown) => boolean {
  const schema = unrolled(JSON.parse(committedWorkspaceSchemas()[file]) as Record<string, unknown>);
  const standard = jsonSchemaToStandardSchema(schema)['~standard'];
  return (value) => {
    const result = standard.validate(value) as { issues?: unknown };
    return result.issues === undefined;
  };
}

export function schemaFileOf(filePath: string): string | undefined {
  return ROUTES.find(([pattern]) => pattern.test(filePath))?.[1];
}
