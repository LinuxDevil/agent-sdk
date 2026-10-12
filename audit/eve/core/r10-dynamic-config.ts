// CORE: dynamic (per-run) config - what context do the resolver functions get? (deterministic)
// Run: npx tsx eve/core/r10-dynamic-config.ts
import { createAgent } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';

const seen: Record<string, unknown>[] = [];

// A sub-agent whose instructions depend on the caller (tier from metadata, tenant from principal).
const researcher = createAgent({
  name: 'researcher',
  description: 'Researches things',
  provider: mockModel(['research done'], { onExhausted: 'repeat-last' }),
  instructions: (ctx) => {
    seen.push({ who: 'subagent', metadata: ctx.metadata, principal: ctx.principal, sessionId: ctx.sessionId });
    return `You serve tenant ${ctx.principal?.id ?? '??'} on plan ${String(ctx.metadata?.plan ?? '??')}.`;
  },
});

const lead = createAgent({
  provider: mockModel([{ toolCalls: [{ name: 'task', args: { agent: 'researcher', subagent_type: 'researcher', description: 'r', prompt: 'look into X' } }] }, 'final']),
  instructions: (ctx) => {
    seen.push({ who: 'lead', metadata: ctx.metadata, principal: ctx.principal });
    return 'You coordinate.';
  },
  subagents: { researcher },
});

const r = await lead.send('go', { metadata: { plan: 'pro' }, principal: { id: 'acme', kind: 'user' } as any });
console.log('finishReason=%s', r.finishReason);
for (const s of seen) console.log(JSON.stringify(s));
