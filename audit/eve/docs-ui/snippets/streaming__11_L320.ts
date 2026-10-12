// streaming.md:320
import { createServer } from 'node:http';
import { createAgent } from '@lousho/build-ai-agent';

const agent = createAgent({ model: 'openai/gpt-4o-mini' });

createServer(async (req, res) => {
  const question = new URL(req.url ?? '/', 'http://localhost').searchParams.get('q') ?? 'Hello!';
  const controller = new AbortController();
  res.on('close', () => controller.abort());

  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  for await (const event of agent.stream(question, { signal: controller.signal })) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  res.end();
}).listen(3000);
export {};
