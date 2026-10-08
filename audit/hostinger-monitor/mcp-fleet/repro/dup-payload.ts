// Offline repro: how big is the `tool` message the model receives for an MCP text result?
// A fake MCP client returns a metrics-shaped JSON payload as one text part (what hostinger-api-mcp does).
import { createAgent, estimateTokens } from '@lousho/build-ai-agent';
import { loadMcpTools } from '@lousho/build-ai-agent/mcp';
import { mockModel } from '@lousho/build-ai-agent/testing';

const usage: Record<string, number> = {};
for (let i = 0; i < 200; i++) usage[String(1791431367 + i * 1800)] = 3434729472 + i;
const payload = JSON.stringify({ cpu_usage: { unit: '%', usage }, ram_usage: { unit: 'bytes', usage } });

const fakeClient = {
  listTools: async () => ({ tools: [{ name: 'execute', description: 'run op', inputSchema: { type: 'object', properties: { operation: { type: 'string' } }, required: ['operation'] }, annotations: { readOnlyHint: true } }] }),
  callTool: async () => ({ content: [{ type: 'text', text: payload }] }),
};
const tools = await loadMcpTools(fakeClient, 'h');
const agent = createAgent({
  provider: mockModel([{ toolCalls: [{ name: 'h__execute', args: { operation: 'x' } }] }, { text: 'ok' }]),
  instructions: 't',
  tools,
});
const r = await agent.send('go');
const toolMsg: any = r.messages.find((m: any) => m.role === 'tool');
console.log('raw MCP text payload chars      :', payload.length);
console.log('tool message content chars      :', toolMsg.content.length, `(x${(toolMsg.content.length / payload.length).toFixed(2)})`);
console.log('estimateTokens(raw) vs (message):', estimateTokens(payload), 'vs', estimateTokens(toolMsg.content));
console.log('message starts with             :', toolMsg.content.slice(0, 120));
