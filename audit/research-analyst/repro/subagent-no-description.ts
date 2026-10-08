/**
 * Repro: createAgent() must fail fast (LOUSHO_CONFIG_INVALID) when a
 * sub-agent lacks a `description` — the lead model picks sub-agents by it.
 * Offline: throws at createAgent(), before any model call.
 * Run: npx tsx research-analyst/repro/subagent-no-description.ts
 */
import '../../_shared/env.js';
import { createAgent } from '@lousho/build-ai-agent';
import { LIVE_MODEL } from '../../_shared/env.js';

const silent = createAgent({ model: LIVE_MODEL, instructions: 'No description on purpose.' });
try {
  createAgent({ model: LIVE_MODEL, instructions: 'lead', subagents: { silent } });
  console.log('[FAIL] no-description :: createAgent accepted a description-less sub-agent');
} catch (error) {
  const e = error as Error & { code?: string };
  console.log(`[${e.code === 'LOUSHO_CONFIG_INVALID' ? 'PASS' : 'FAIL'}] no-description :: code=${e.code} :: ${e.message.slice(0, 140)}`);
}
