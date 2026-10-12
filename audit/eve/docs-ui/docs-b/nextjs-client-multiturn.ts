// docs/nextjs.md pairs createRouteHandler (with a store, "so a second turn remembers the first")
// with useLoushoAgent({ url }). The remote runner POSTs only { input } - does turn 2 see turn 1?
import { createAgent, createRouteHandler, memoryStore } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';
import { loushoAgent } from '@lousho/build-ai-agent/svelte'; // same runner as useLoushoAgent (src/ui/agentRunner.ts)

const model = mockModel(['Nice to meet you, Ali.', 'I do not know your name.']);
const agent = createAgent({ provider: model, store: memoryStore() });
const { handler } = createRouteHandler(agent, { basePath: '/api/agent' });
const bodies: string[] = [];
const fetchViaHandler: typeof fetch = async (url, init) => {
  bodies.push(String(init?.body));
  return handler(new Request(new URL(String(url), 'http://app.local'), init as RequestInit));
};
const store: any = loushoAgent({ url: '/api/agent', fetch: fetchViaHandler } as any);
await store.send('My name is Ali.');
await store.send('What is my name?');
console.log('bodies POSTed by the client:', bodies);
console.log('turn 2 request to the model:', model.calls[1].messages.map((m: any) => `${m.role}: ${m.content}`));
