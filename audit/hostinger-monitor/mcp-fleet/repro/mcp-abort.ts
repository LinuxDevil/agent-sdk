// Offline: is a run's abort signal / timeout forwarded to an MCP tools/call?
import { createAgent } from '@lousho/build-ai-agent';
import { loadMcpTools } from '@lousho/build-ai-agent/mcp';
import { mockModel } from '@lousho/build-ai-agent/testing';

let seenOptions: unknown = 'not called';
let serverFinished = false;
const fakeClient = {
  listTools: async () => ({ tools: [{ name: 'slow_metrics', description: 'slow', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } }] }),
  callTool: async (_p: unknown, _schema?: unknown, options?: any) => {
    seenOptions = options === undefined ? 'undefined' : Object.keys(options);
    await new Promise((r) => setTimeout(r, 3000)); // a slow Hostinger API call
    serverFinished = true;
    return { content: [{ type: 'text', text: '{"cpu":1}' }] };
  },
};
const tools = await loadMcpTools(fakeClient, 'h');
const agent = createAgent({ provider: mockModel([{ toolCalls: [{ name: 'h__slow_metrics', args: {} }] }, { text: 'done' }]), instructions: 'x', tools });
const ac = new AbortController();
const t0 = Date.now();
setTimeout(() => ac.abort(new Error('operator cancelled')), 300);
try {
  const r = await agent.send('go', { signal: ac.signal });
  console.log(`send resolved after ${Date.now() - t0}ms finishReason=${r.finishReason}`);
} catch (e: any) {
  console.log(`send rejected after ${Date.now() - t0}ms: ${e?.name}: ${e?.message}`);
}
console.log('options passed to client.callTool():', JSON.stringify(seenOptions), '| MCP request still running after abort:', !serverFinished);
await new Promise((r) => setTimeout(r, 3200));
console.log('MCP call completed in the background anyway:', serverFinished);
