import { createAgent } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';
const researcher = createAgent({ provider: mockModel(['found sources']), instructions: 'You research.', description: 'Finds sources' });
const lead = createAgent({ provider: mockModel([{ toolCalls: [{ name: 'task', args: { agent: 'researcher', prompt: 'bikes', description: 'find sources' } }] }, 'Here is the essay']), instructions: 'You coordinate.', subagents: { researcher } });
const out: string[] = [];
for await (const e of lead.stream('Write about bicycles')) out.push(e.subagent ? `[${e.subagent.name} d${e.subagent.depth} ${e.subagent.toolCallId} "${(e.subagent as any).description}"] ${e.type}` : e.type);
console.log(out.join('\n'));
