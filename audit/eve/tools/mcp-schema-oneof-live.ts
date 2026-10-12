// LIVE (1 cheap call): does the collapsed schema break a real provider request?
// Run: cd E:\agent-sdk\audit && npx tsx eve/tools/mcp-schema-oneof-live.ts
import { LIVE_MODEL, hasLiveKey } from '../../_shared/env.ts';
import { createAgent } from '@lousho/build-ai-agent';
import { loadMcpTools } from '@lousho/build-ai-agent/mcp';
if (!hasLiveKey) { console.log('no key'); process.exit(0); }
const inputSchema = {
  type: 'object',
  properties: { owner: { type: 'string' }, repo: { type: 'string' }, issue_number: { type: 'integer' }, title: { type: 'string' } },
  required: ['owner', 'repo'],
  oneOf: [{ required: ['issue_number'] }, { required: ['title'] }],
};
let got: unknown = '(never called)';
const fakeClient = {
  listTools: async () => ({ tools: [{ name: 'get_issue', description: 'Get a GitHub issue by number or title', inputSchema, annotations: { readOnlyHint: true } }] }),
  callTool: async (p: any) => { got = p.arguments; return { content: [{ type: 'text', text: 'Issue: "Crash on start", open' }] }; },
};
const tools = await loadMcpTools(fakeClient, 'gh');
const agent = createAgent({ model: LIVE_MODEL, tools, maxSteps: 3 });
try {
  const r = await agent.send('Use gh__get_issue to fetch issue 7 of repo vercel/next.js and tell me its title.');
  console.log('finish:', r.finishReason, '| args the server received:', JSON.stringify(got), '| text:', r.text.slice(0, 150));
} catch (e) {
  console.log('THREW:', (e as any).code, String((e as Error).message).slice(0, 300));
}
