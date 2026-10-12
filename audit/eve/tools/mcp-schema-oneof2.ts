// What JSON Schema a real provider sends for the converted MCP schema (provider path: z.toJSONSchema draft-7, io input).
import { z } from 'zod';
import { jsonSchemaToZod } from '@lousho/build-ai-agent/mcp';
const base = {
  type: 'object',
  properties: { owner: { type: 'string' }, repo: { type: 'string' }, issue_number: { type: 'integer' }, title: { type: 'string' } },
  required: ['owner', 'repo'],
};
for (const [label, schema] of [
  ['object + sibling oneOf', { ...base, oneOf: [{ required: ['issue_number'] }, { required: ['title'] }] }],
  ['object + sibling anyOf', { ...base, anyOf: [{ required: ['issue_number'] }, { required: ['title'] }] }],
  ['object + sibling $ref-less enum? (control: plain object)', base],
] as const) {
  const zs = jsonSchemaToZod(schema) as any;
  const js = z.toJSONSchema(zs, { target: 'draft-7', io: 'input', unrepresentable: 'any' });
  console.log(`${label}:\n  model gets ${JSON.stringify(js)}`);
  console.log('  {owner:42,bogus:1} valid?', zs.safeParse({ owner: 42, bogus: 1 }).success, ' {} valid?', zs.safeParse({}).success);
}
