// How does the 9B model cope with the Hostinger API exposed as 64 per-operation tools (FAKE, canned data)?
// A: all 64 upfront   B: deferLoading + tool_search   (usage: tsx many-tools.ts A|B)
import { createAgent, defineTool, estimateTokens, registerModel } from '@lousho/build-ai-agent';
import { z } from 'zod';
import { localProvider, LOCAL_MODEL } from '../../../_shared/local.js';
import { readFileSync } from 'node:fs';

registerModel({ id: LOCAL_MODEL, contextWindow: 8192 } as any);
// operation names captured from the real server's `search` tool (enumerate-ops.ts)
const ops = readFileSync(new URL('./ops.txt', import.meta.url), 'utf8').split(/\r?\n/).filter(Boolean);
const called: string[] = [];
const tools = ops.map((line) => {
  const [mode, op] = line.split(' ');
  return defineTool({
    name: op.replace(/[^a-zA-Z0-9_-]/g, '_'),
    description: `${mode === 'RO' ? 'Read' : 'MUTATES'}: Hostinger ${op.replace(/_/g, ' ')}`,
    input: z.object({ virtualMachineId: z.number().optional() }),
    deferLoading: process.argv[2] === 'B',
    annotations: { readOnlyHint: mode === 'RO' },
    needsApproval: mode !== 'RO' ? { deny: 'read-only monitor' } as any : false,
    execute: async (a) => {
      called.push(op);
      if (op === 'vps_virtual-machines_list') return [{ id: 1, hostname: 'srv1', state: 'running' }];
      if (op === 'vps_backups_list') return { data: [{ id: 9, created_at: '2026-10-04T11:21:53Z' }] };
      return { ok: true, ...a };
    },
  });
});
const defsTokens = estimateTokens(JSON.stringify(tools.map((t: any) => ({ n: t.name, d: t.description }))));
const agent = createAgent({ provider: localProvider(), instructions: 'You are a read-only VPS monitor. Use tools to answer.', tools, maxSteps: 6, ...(process.argv[2] === 'B' && { toolSearch: { maxResults: 3 } }) });
const t0 = Date.now();
const steps: string[] = [];
try {
  const r = await agent.send('List my VPS and tell me when the newest backup of each was taken.', {});
  for (const m of r.messages as any[]) if (m.role === 'assistant') for (const tc of m.toolCalls ?? []) steps.push(`${tc.function?.name ?? tc.name}(${tc.function?.arguments ?? ''})`);
  console.log(`[${process.argv[2]}] ${Date.now() - t0}ms finish=${r.finishReason} promptTokens(step1)=${(r as any).steps?.[0]?.usage?.promptTokens ?? '?'} usage=${JSON.stringify(r.usage)}`);
  console.log('  model tool calls:', steps.join(' -> '));
  console.log('  answer:', r.text.slice(0, 200).replace(/\n/g, ' '));
} catch (e: any) {
  console.log(`[${process.argv[2]}] FAILED after ${Date.now() - t0}ms: ${e.code}: ${String(e.message).slice(0, 160)}`);
}
console.log('  executed fake ops:', called.join(', '), '| ~tool-def tokens (names+descriptions only):', defsTokens);
