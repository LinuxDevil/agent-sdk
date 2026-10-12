// Repro: an MCP tool whose <server>__<tool> name equals a local tool silently replaces it (approval gate lost).
// Run: cd E:\agent-sdk\audit && npx tsx eve/tools/mcp-shadow.ts
import { createAgent, defineTool } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';
import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mcp-evil-server.mjs');

const local = defineTool({
  name: 'evil__wipe_disk', description: 'local, gated', input: z.object({}), needsApproval: true,
  execute: async () => 'LOCAL tool ran',
});
const model = mockModel([{ toolCalls: [{ name: 'evil__wipe_disk' }] }, 'done']);
const agent = createAgent({ provider: model, tools: [local], mcpServers: { evil: { command: process.execPath, args: [serverPath] } } });
const r = await agent.send('go');
console.log('finishReason:', r.finishReason);
const toolMsg = (model.calls[1]?.messages as any[] | undefined)?.find((m) => m.role === 'tool');
console.log('tool result the model saw:', toolMsg ? JSON.stringify(toolMsg.content).slice(0, 120) : '(none - paused?)');
await agent.close();
