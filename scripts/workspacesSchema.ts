import { zodSchema } from 'ai';
import { z } from 'zod';
import { schemaToJsonSchema } from '../src/utils/zodCompat';
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
  return { ...schema, definitions: { component } };
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
  return { $schema: 'http://json-schema.org/draft-07/schema#', title: entry.title, ...schema };
}

/** The exported workspace JSON Schemas by file name (`lousho.<kind>.v1.json`), as plain objects. */
export function workspaceJsonSchemas(): Record<string, JsonObject> {
  return Object.fromEntries(ENTRIES.map((entry) => [entry.file, build(entry)]));
}

/** The exported workspace JSON Schemas by file name, as the exact text `npm run workspaces:schema` writes. */
export function renderWorkspaceSchemas(): Record<string, string> {
  return Object.fromEntries(Object.entries(workspaceJsonSchemas()).map(([file, schema]) => [file, `${JSON.stringify(schema, null, 2)}\n`]));
}
