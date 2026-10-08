/**
 * How the SDK surfaces malformed tool calls of the kind a small local model
 * emits. A scripted provider returns raw `arguments` strings (not objects), so
 * the provider -> executor path sees exactly what a sloppy model sends.
 *   npx tsx coding-agent/repro/malformed-tool-calls.ts
 */
import { createAgent, createFsTools, MemoryWorkspace, type AgentEvent, type LLMProvider } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';

const cases: Array<{ label: string; name: string; args: string }> = [
  { label: 'truncated JSON', name: 'read_file', args: '{"path": "a.txt"' },
  { label: 'empty string', name: 'read_file', args: '' },
  { label: 'wrong type', name: 'read_file', args: '{"path": 42}' },
  { label: 'unknown tool (dash)', name: 'read-file', args: '{"path":"a.txt"}' },
  { label: 'namespaced name', name: 'functions.read_file', args: '{"path":"a.txt"}' },
  { label: 'double-encoded JSON', name: 'read_file', args: JSON.stringify(JSON.stringify({ path: 'a.txt' })) },
  { label: 'extra key', name: 'read_file', args: '{"path":"a.txt","encoding":"utf8"}' },
  { label: 'wrong key name', name: 'read_file', args: '{"file_path":"a.txt"}' },
  { label: 'markdown fenced', name: 'read_file', args: '```json\n{"path":"a.txt"}\n```' },
  { label: 'string number', name: 'read_file', args: '{"path":"a.txt","offset":"2"}' },
  { label: 'trailing comma', name: 'read_file', args: '{"path":"a.txt",}' },
  { label: 'truncated JSON, all-optional schema', name: 'list_dir', args: '{"path": "src"' },
];

const inner = mockModel([
  { toolCalls: cases.map((c, i) => ({ name: c.name, id: `c${i}`, args: {} })), usage: { inputTokens: 10, outputTokens: 10 } },
  { text: 'done', usage: { inputTokens: 10, outputTokens: 1 } },
]);
// Swap in the raw argument strings / names the scripted model "sent".
const rewrite = <T extends { toolCalls?: Array<{ id: string; function: { name: string; arguments: string } }> }>(r: T): T => ({
  ...r,
  toolCalls: r.toolCalls?.map((tc, i) => ({ ...tc, function: { name: cases[i].name, arguments: cases[i].args } })),
});
const provider: LLMProvider = {
  ...inner,
  name: 'scripted',
  generate: async (o) => rewrite(await inner.generate(o)),
  stream: inner.stream.bind(inner),
  supportsTools: () => true,
  supportsStreaming: () => false,
  getModels: async () => ['scripted'],
};

const workspace = new MemoryWorkspace({ files: { 'a.txt': 'line1\nline2\n', 'src/inner.js': 'x' } });
const events: AgentEvent[] = [];
const agent = createAgent({ provider, tools: createFsTools(workspace, { readOnly: true }), onEvent: (e) => events.push(e), maxSteps: 4 });
const res = await agent.send('read a.txt');
console.log('finishReason:', res.finishReason, 'text:', res.text);
const toolMsgs = inner.calls[1]?.messages.filter((m) => m.role === 'tool') ?? [];
for (const [i, c] of cases.entries()) {
  const ev = events.find((e) => (e.type === 'tool.done' || e.type === 'tool.error') && e.toolCallId === `c${i}`);
  const start = events.find((e) => e.type === 'tool.start' && e.toolCallId === `c${i}`) as Extract<AgentEvent, { type: 'tool.start' }> | undefined;
  const msg = toolMsgs.find((m) => (m as { toolCallId?: string }).toolCallId === `c${i}`);
  const content = typeof msg?.content === 'string' ? msg.content : JSON.stringify(msg?.content);
  console.log(`\n# ${c.label}: ${c.name}(${JSON.stringify(c.args)})`);
  console.log(`  tool.start args = ${JSON.stringify(start?.args)}`);
  console.log(`  event: ${ev?.type} ${ev?.type === 'tool.error' ? `${ev.error.name}: ${ev.error.message.slice(0, 160)}` : ''}`);
  console.log(`  model sees: ${content?.slice(0, 260)}`);
}
