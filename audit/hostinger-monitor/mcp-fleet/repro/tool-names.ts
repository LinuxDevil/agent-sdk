// Offline: MCP tool-name sanitization. MCP allows names that LLM providers reject (^[a-zA-Z0-9_-]{1,64}$).
import { createAgent, defineTool } from '@lousho/build-ai-agent';
import { loadMcpTools } from '@lousho/build-ai-agent/mcp';
import { mockModel } from '@lousho/build-ai-agent/testing';
import { z } from 'zod';

const names = ['vps.list', 'get metrics', 'ns/tool', 'x'.repeat(60), 'execute'];
const fakeClient = {
  listTools: async () => ({ tools: names.map((name) => ({ name, description: 'd', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } })) }),
  callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
};
const skipped: unknown[] = [];
const tools = await loadMcpTools(fakeClient, 'hostinger.vps', { onSkip: (s) => skipped.push(s) });
const re = /^[a-zA-Z0-9_-]{1,64}$/;
for (const k of Object.keys(tools)) console.log(`${re.test(k) ? 'valid  ' : 'INVALID'} ${k.length.toString().padStart(3)} ${k.slice(0, 80)}`);
console.log('skipped by loader:', skipped.length);

let sent: string[] = [];
const provider = mockModel(['ok']);
const orig = provider.generate.bind(provider);
provider.generate = (o: any) => ((sent = (o.tools ?? []).map((t: any) => t.function?.name ?? t.name)), orig(o));
const agent = createAgent({ provider, instructions: 'x', tools });
await agent.send('hi');
console.log('names sent to the provider:', sent.filter((n) => !re.test(n)).length, 'invalid of', sent.length);
try {
  defineTool({ name: 'hostinger.vps__vps.list', description: 'd', input: z.object({}), execute: async () => 1 });
} catch (e: any) {
  console.log('defineTool() with the same name throws:', e.code ?? e.name, '-', String(e.message).slice(0, 90));
}
