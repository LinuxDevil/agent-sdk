/**
 * loadAgentDir() on an installed coding-kit (from repro/kit.sh):
 *  A. are documented createAgent() overrides (onEvent, guardrails, ...) honored?
 *  B. does the receipt's "exec: true => always wait for approval" hold?
 *  C. the kit's loop guard is a module singleton shared by every loaded agent.
 *   npx tsx coding-agent/repro/loadagentdir-overrides.ts <kit-dir>
 */
import { createAgent, loadAgentDir, resolveAgentDir, type IoGuardrail, type SimpleAgent } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';

const dir = process.argv[2];
const shellCall = () => mockModel([{ toolCalls: [{ name: 'shell', args: { command: 'node --test' } }] }, 'done']);
const blockShell: IoGuardrail = { name: 'block-shell', check: ({ toolName }) => (toolName === 'shell' ? { ok: false, reason: 'no shell' } : { ok: true }) };

/** Runs via stream() (onEvent overrides are dropped, see A) and describes what happened to the shell call. */
async function describe(agent: SimpleAgent): Promise<string> {
  const seen: string[] = [];
  for await (const e of agent.stream('go')) {
    if (e.type === 'tool.done') seen.push(`ran(exit=${(e.result as { exitCode?: number })?.exitCode})`);
    if (e.type === 'tool.error') seen.push(`tool.error(${e.error.message.slice(0, 70)})`);
    if (e.type === 'approval.requested') seen.push('approval.requested');
    if (e.type === 'guardrail.tripped') seen.push(`guardrail.tripped(${e.name})`);
    if (e.type === 'permission.decision') seen.push(`perm=${e.decision}${e.hook ? `/hook=${e.hook}` : ''}`);
    if (e.type === 'run.done') seen.push(`run.done=${e.finishReason}`);
  }
  return seen.join(' ');
}

console.log('--- A. overrides');
const events: string[] = [];
const viaDir = await loadAgentDir(dir, { provider: shellCall(), onEvent: (e) => events.push(e.type), guardrails: { tools: [blockShell] }, hooks: null });
console.log(`loadAgentDir(dir, {onEvent, guardrails}): ${await describe(viaDir)}; onEvent calls=${events.length}`);
const { config } = await resolveAgentDir(dir, { provider: shellCall(), onEvent: () => {}, guardrails: { tools: [blockShell] }, retry: { maxRetries: 1 }, reasoning: 'low', redactContent: true, hooks: null } as never);
console.log('keys resolveAgentDir kept:', Object.keys(config).sort().join(', '));
const events2: string[] = [];
const direct = createAgent({ ...config, provider: shellCall(), onEvent: (e) => events2.push(e.type), guardrails: { tools: [blockShell] } });
console.log(`createAgent({...config, onEvent, guardrails}): ${await describe(direct)}; onEvent calls=${events2.length}`);

console.log('--- B. receipt approval enforcement (hooks: null so the loop guard stays out of it)');
console.log(`kit as installed (approve.ts + agent.json rules):      ${await describe(await loadAgentDir(dir, { provider: shellCall(), hooks: null }))}`);
console.log(`approve: null, kit's agent.json rules kept:             ${await describe(await loadAgentDir(dir, { provider: shellCall(), hooks: null, approve: null }))}`);
console.log(`approve: null, permissions: []:                         ${await describe(await loadAgentDir(dir, { provider: shellCall(), hooks: null, approve: null, permissions: [] }))}`);

console.log('--- C. kit hooks are shared module state across separately loaded agents');
for (let i = 1; i <= 3; i++) {
  const agent = await loadAgentDir(dir, { provider: shellCall() }); // a fresh agent each time, e.g. one per HTTP request
  console.log(`agent #${i}: ${await describe(agent)}`);
}
