/* Eve multiagent repro 11: following docs/sub-agents.md quick start (no `name` on agents), every
 * span of a multi-agent trace is attributed to an agent called "agent" - the sub-agent's key
 * ('researcher', 'writer') appears nowhere in the trace. Run: npx tsx eve/multiagent/r11-span-names.ts */
import { createAgent } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';
const spans: any[] = [];
const researcher = createAgent({ provider: mockModel(['r']), instructions: 'You research.', description: 'Finds sources' });
const writer = createAgent({ provider: mockModel(['w']), instructions: 'You write.', description: 'Writes' });
const lead = createAgent({
  provider: mockModel([{ toolCalls: [
    { name: 'task', args: { agent: 'researcher', prompt: 'p', description: 'research' } },
    { name: 'task', args: { agent: 'writer', prompt: 'p', description: 'write' } }] }, 'done']),
  instructions: 'You coordinate.', subagents: { researcher, writer },
  exporter: { onSpanStart() {}, onSpanEnd: (s) => spans.push(s) },
});
await lead.send('go');
for (const s of spans.filter((s) => s.name.startsWith('invoke_agent')))
  console.log(s.name, '| gen_ai.agent.name =', s.attributes['gen_ai.agent.name'], '| attrs mentioning researcher/writer:', Object.entries(s.attributes).filter(([, v]) => /researcher|writer/.test(String(v))).map(([k]) => k));
const taskSpans = spans.filter((s) => s.name === 'execute_tool task');
console.log('execute_tool task spans carry the sub-agent name?', taskSpans.map((s) => Object.entries(s.attributes).filter(([, v]) => /researcher|writer/.test(String(v))).map(([k]) => k)));
