// CORE-F1 repro: the UI bindings' remote mode never sends a sessionId, so every
// browser turn is a brand-new session on createRouteHandler() - the chat forgets.
// Run: npx tsx eve/core/r1-ui-remote-multiturn.ts   (from E:\agent-sdk\audit)
import { createAgent, createRouteHandler, memoryStore } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';
import { loushoAgent } from '@lousho/build-ai-agent/svelte';

const seen: number[] = [];
const model = mockModel(
  [
    (req) => {
      const users = req.messages.filter((m) => m.role === 'user').length;
      seen.push(users);
      return `I can see ${users} user message(s).`;
    },
  ],
  { onExhausted: 'repeat-last' }
);
const agent = createAgent({ provider: model, store: memoryStore() });
const { handler } = createRouteHandler(agent, { basePath: '/api/agent', auth: 'tok' });

const bodies: string[] = [];
const fakeFetch: typeof fetch = async (input, init) => {
  bodies.push(String(init?.body));
  return handler(new Request(new URL(String(input), 'http://localhost'), init as RequestInit));
};

const chat = loushoAgent({ url: 'http://localhost/api/agent', headers: { Authorization: 'Bearer tok' }, fetch: fakeFetch });
let state: any;
chat.subscribe((s) => (state = s));
await chat.send('My name is Ali.');
await chat.send('What is my name?');

console.log('POST bodies sent by the UI binding:', bodies);
console.log('user messages the model saw per turn:', seen);
console.log('UI messages:', state.messages.map((m: any) => `${m.role}: ${m.text}`));
console.log(seen[1] === 1 ? '[FAIL] turn 2 started a fresh session - the chat has amnesia' : '[PASS] turn 2 saw turn 1');
