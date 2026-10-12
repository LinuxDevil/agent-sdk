// tools.md:299
import { createAgent, defineTool, type ToolOutput } from '@lousho/build-ai-agent';
import { z } from 'zod';

const buildReport = defineTool({
  name: 'build_report',
  description: 'Builds a report from several sources',
  input: z.object({ topic: z.string() }),
  async *execute({ topic }, ctx) {
    const sections: string[] = [];
    for (const source of ['news', 'papers', 'forums']) {
      if (ctx.abortSignal?.aborted) return;
      sections.push(`${source}: notes on ${topic}`);
      yield { topic, sections: [...sections], done: false };
    }
    yield { topic, sections, done: true };
  },
});
type Report = ToolOutput<typeof buildReport>; // { topic: string; sections: string[]; done: boolean }

const agent = createAgent({ model: 'openai/gpt-4o-mini', tools: [buildReport] });
for await (const event of agent.stream('Write a report on solar power.')) {
  if (event.type === 'tool.partial') console.log(`step ${event.index}`, event.output);
}
export {};
