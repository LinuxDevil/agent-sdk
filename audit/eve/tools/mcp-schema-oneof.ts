// Repro: an object schema with sibling `oneOf`/`anyOf` (a common "one of these fields is required" pattern)
// collapses to z.any(): the model is sent NO properties and NO type for the tool's input.
// Run: cd E:\agent-sdk\audit && npx tsx eve/tools/mcp-schema-oneof.ts
import { createAgent } from '@lousho/build-ai-agent';
import { loadMcpTools } from '@lousho/build-ai-agent/mcp';
import { mockModel } from '@lousho/build-ai-agent/testing';

const inputSchema = {
  type: 'object',
  properties: {
    owner: { type: 'string', description: 'Repo owner' },
    repo: { type: 'string', description: 'Repo name' },
    issue_number: { type: 'integer' },
    title: { type: 'string' },
  },
  required: ['owner', 'repo'],
  oneOf: [{ required: ['issue_number'] }, { required: ['title'] }],
};
const fakeClient = {
  listTools: async () => ({ tools: [{ name: 'get_issue', description: 'Get an issue by number or title', inputSchema }] }),
  callTool: async (p: any) => ({ content: [{ type: 'text', text: 'server got ' + JSON.stringify(p.arguments) }] }),
};
const tools = await loadMcpTools(fakeClient, 'gh');
const model = mockModel([{ toolCalls: [{ name: 'gh__get_issue', args: { owner: 42, bogus: true } }] }, 'done']);
const res = await createAgent({ provider: model, tools }).send('x'); console.log('finish:', res.finishReason, res.text?.slice(0,200));
const def = (model.calls[0].tools as any[]).find((t) => JSON.stringify(t).includes('get_issue'));
console.log('tool definition sent to the model:', JSON.stringify(def));
const toolMsg = ((model.calls[1]?.messages ?? []) as any[]).find((m) => m.role === 'tool');
console.log('invalid args {owner:42,bogus:true} ->', String(JSON.stringify(toolMsg?.content)).slice(0, 160));
