import { createAgent, defineTool, createWebFetchTool } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';
import { z } from 'zod';
const buildReport = defineTool({
  name: 'build_report', description: 'Builds a report from several sources', input: z.object({ topic: z.string() }),
  async *execute({ topic }, ctx) {
    const sections: string[] = [];
    for (const source of ['news', 'papers', 'forums']) { if (ctx.abortSignal?.aborted) return; sections.push(`${source}: notes on ${topic}`); yield { topic, sections: [...sections], done: false }; }
    yield { topic, sections, done: true };
  },
});
const empty = defineTool({ name: 'empty', description: 'd', input: z.object({}), async *execute() { return 'ignored' as any; } });
const agent = createAgent({ provider: mockModel([{ toolCalls: [{ name: 'build_report', args: { topic: 'solar' } }, { name: 'empty', args: {} }] }, 'ok']), tools: [buildReport, empty] });
const run = agent.stream('Write a report on solar power.');
for await (const event of run) {
  if (event.type === 'tool.partial') console.log(`partial index ${(event as any).index}`, JSON.stringify((event as any).output).slice(0, 60));
  if (event.type === 'tool.done') console.log('tool.done', (event as any).toolName ?? (event as any).name, JSON.stringify((event as any).result).slice(0, 80));
}
const res = await run.result;
console.log('transcript:', res.messages.filter((m: any) => m.role === 'tool').map((m: any) => String(m.content).slice(0, 80)));
// web_fetch refusals (no network needed)
const wf: any = createWebFetchTool({ allowedHosts: ['*.example.com'] });
const wf2: any = createWebFetchTool({});
const call = async (tool: any, url: string) => { const m = mockModel([{ toolCalls: [{ name: 'web_fetch', args: { url } }] }, 'k']); const r = await createAgent({ provider: m, tools: [tool] }).send('x'); return String(r.messages.find((x: any) => x.role === 'tool')?.content).slice(0, 170); };
console.log('127.0.0.1:', await call(wf2, 'http://127.0.0.1:9/'));
console.log('169.254.169.254:', await call(wf2, 'http://169.254.169.254/latest/meta-data'));
console.log('localhost:', await call(wf2, 'http://localhost:9/'));
console.log('allowed *.example.com, bare example.com:', await call(wf, 'https://example.com/'));
console.log('user:pass@:', await call(wf2, 'https://u:p@example.com/'));
console.log('ftp:', await call(wf2, 'ftp://example.com/'));
