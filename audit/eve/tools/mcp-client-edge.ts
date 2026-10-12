// Repro: pagination, annotation trust, env, unbounded results/descriptions.
// Run: cd E:\agent-sdk\audit && npx tsx eve/tools/mcp-client-edge.ts
import { createAgent } from '@lousho/build-ai-agent';
import { connectMcp } from '@lousho/build-ai-agent/mcp';
import { mockModel } from '@lousho/build-ai-agent/testing';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, 'mcp-evil-server.mjs');
process.env.AUDIT_FAKE_SECRET = 'not-a-real-secret';

const mcp = await connectMcp({ evil: { command: process.execPath, args: [serverPath] } });
console.log('[1] loaded tools:', Object.keys(mcp.tools));
console.log('    second_page_tool present?', 'evil__second_page_tool' in mcp.tools);

const wipe = mcp.tools.evil__wipe_disk;
console.log('[2] evil__wipe_disk needsApproval =', wipe.needsApproval, ' annotations =', JSON.stringify((wipe as any).metadata?.mcp?.annotations));

console.log('[3] huge_desc description length passed to model =', JSON.stringify(Object.keys(mcp.tools.evil__huge_desc)), (mcp.tools.evil__huge_desc as any).description?.length ?? (mcp.tools.evil__huge_desc as any).displayName?.length);

const envNames: string[] = JSON.parse(((await mcp.tools.evil__env_dump.execute!({}, {} as any)) as any).text);
console.log('[4] child sees AUDIT_FAKE_SECRET?', envNames.includes('AUDIT_FAKE_SECRET'), ' (#vars:', envNames.length, ')');

// [5] what the model receives for an image / huge text result
const model = mockModel([{ toolCalls: [{ name: 'evil__screenshot' }, { name: 'evil__big_text' }] }, 'done']);
const agent = createAgent({ provider: model, tools: mcp.tools });
await agent.send('take a screenshot');
const second = model.calls[1];
for (const m of second.messages as any[]) {
  if (m.role !== 'tool') continue;
  const s = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
  console.log(`[5] tool message ${m.toolCallId ?? ''} -> ${s.length} chars sent to model; starts: ${s.slice(0, 80)}`);
}

const toolDefs = (model.calls[0] as any).tools ?? [];
const hd = toolDefs.find((t: any) => JSON.stringify(t).includes('huge_desc'));
console.log('[6] huge_desc tool definition sent to model:', hd ? JSON.stringify(hd).length + ' chars' : 'not found; keys=' + Object.keys(model.calls[0]));
await mcp.close();
