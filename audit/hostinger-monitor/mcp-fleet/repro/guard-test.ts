// Verifies the read-only guard with FAKE tools and a scripted mock model.
// No real MCP server is involved: nothing can reach Hostinger from this script.
import { createAgent, defineTool, type PermissionDecisionEntry } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';
import { z } from 'zod';
import { EXECUTE_TOOL, MULTI_TOOL, SEARCH_TOOL, guardHook, guardMcpTools, guardPermissions } from '../guard.js';

const executed: string[] = [];
const fake = (name: string, input: z.ZodTypeAny) =>
  ({ ...defineTool({ name, description: `fake ${name}`, input, execute: async (a: any) => { executed.push(`${name}:${a?.operation ?? ''}`); return { ok: true }; } }), name });

const rawTools = {
  [SEARCH_TOOL]: fake(SEARCH_TOOL, z.object({ query: z.string() })),
  [EXECUTE_TOOL]: { ...fake(EXECUTE_TOOL, z.object({ operation: z.string(), params: z.record(z.string(), z.unknown()).optional() })), needsApproval: true },
  [MULTI_TOOL]: { ...fake(MULTI_TOOL, z.object({ steps: z.array(z.any()) })), needsApproval: true },
  rogue_tool: fake('rogue_tool', z.object({})),
};

const calls = [
  { name: EXECUTE_TOOL, args: { operation: 'vps_virtual-machines_stop', params: { virtualMachineId: 1 } } },
  { name: EXECUTE_TOOL, args: { operation: 'vps_virtual-machines_list' } },
  { name: EXECUTE_TOOL, args: { operation: 'VPS_VIRTUAL-MACHINES_LIST' } },
  { name: EXECUTE_TOOL, args: { operation: 'vps_virtual-machines_list ', params: {} } },
  { name: EXECUTE_TOOL, args: { operation: 'vps_virtual-machines_purchase', params: { item_id: 'x', setup: 'y' } } },
  { name: MULTI_TOOL, args: { steps: [{ operation: 'vps_virtual-machines_list' }, { operation: 'vps_virtual-machines_stop', params: { virtualMachineId: '$steps.0.0.id' } }] } },
  { name: 'rogue_tool', args: {} },
  { name: SEARCH_TOOL, args: { query: 'stop vm' } },
];

async function run(label: string, cfg: { tools: Record<string, any>; permissions?: any; hooks?: any }) {
  executed.length = 0;
  const decisions: PermissionDecisionEntry[] = [];
  const agent = createAgent({
    provider: mockModel([{ toolCalls: calls }, { text: 'done' }]),
    instructions: 'test',
    tools: cfg.tools,
    permissions: cfg.permissions,
    hooks: cfg.hooks,
    onPermissionDecision: (e) => decisions.push(e),
    maxSteps: 3,
  });
  const r = await agent.send('go');
  const toolMsgs = r.messages.filter((m: any) => m.role === 'tool').map((m: any) => `${m.toolName}: ${String(m.content).slice(0, 110)}`);
  console.log(`\n== ${label} == finishReason=${r.finishReason} approvalId=${(r as any).approvalId ?? '-'}`);
  console.log('executed (reached fake tool body):', JSON.stringify(executed));
  console.log('decisions:', decisions.map((d) => `${d.toolName}=${d.decision}`).join(', '));
  for (const t of toolMsgs) console.log('  ', t);
}

await run('A: all layers', { tools: guardMcpTools(rawTools), permissions: guardPermissions, hooks: [guardHook] });
await run('B: permissions only, unfiltered tools', { tools: rawTools, permissions: guardPermissions });
await run('C: hook only, unfiltered tools', { tools: rawTools, hooks: [guardHook] });
await run('D: wrapper/filter only (no rules, no hook)', { tools: guardMcpTools(rawTools) });
await run('E: NO guard (baseline: what the SDK does by default)', { tools: rawTools });
