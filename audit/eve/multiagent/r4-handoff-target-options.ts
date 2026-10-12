/* Eve multiagent repro 4: a handoff target's own run options are overwritten by the lead's - even
 * by options the lead never set (undefined). docs/tool-search.md says "the target's own deferLoading
 * tools and toolSearch apply" after a handoff.
 * Run: npx tsx eve/multiagent/r4-handoff-target-options.ts */
import { createAgent, defineTool } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';
import { z } from 'zod';

const lookup = defineTool({ name: 'lookup_invoice', description: 'Look up an invoice', input: z.object({ id: z.string() }), deferLoading: true, execute: async () => 'inv' });

function run(label: string, targetExtra: Record<string, unknown>, leadExtra: Record<string, unknown>) {
  const billingModel = mockModel(['billing answer']);
  const triageModel = mockModel([{ toolCalls: [{ name: 'transfer_to_billing', args: {} }] }]);
  const billing = createAgent({ name: 'billing', description: 'Billing desk', provider: billingModel, instructions: 'billing', tools: [lookup], ...targetExtra } as any);
  const triage = createAgent({ name: 'triage', provider: triageModel, instructions: 'triage', handoffs: [billing], ...leadExtra } as any);
  return triage.send('charged twice').then((r) => {
    const tools = (billingModel.calls[0]?.tools ?? []).map((t: any) => t.name ?? t.function?.name);
    console.log(`${label}: agentName=${r.agentName}; target's first request offers tools ${JSON.stringify(tools)}`);
  });
}

// Standalone, the target defers (toolSearch thresholdPercent 0) -> it should be offered tool_search, not lookup_invoice.
{
  const m = mockModel(['x']);
  const solo = createAgent({ name: 'billing', description: 'Billing desk', provider: m, instructions: 'billing', tools: [lookup], toolSearch: { thresholdPercent: 0 } } as any);
  await solo.send('hi');
  console.log(`standalone billing: tools ${JSON.stringify((m.calls[0]?.tools ?? []).map((t: any) => t.name ?? t.function?.name))}`);
}
await run('target toolSearch {thresholdPercent:0}, lead unset', { toolSearch: { thresholdPercent: 0 } }, {});
await run('target toolSearch {thresholdPercent:0}, lead toolSearch:false', { toolSearch: { thresholdPercent: 0 } }, { toolSearch: false });
await run('target maxSteps 1 (would stop it), lead unset', { maxSteps: 1 }, {});
