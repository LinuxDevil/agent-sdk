// nextjs.md:15
// app/api/agent/[[...path]]/route.ts
import { createAgent, createRouteHandler, memoryStore } from '@lousho/build-ai-agent';

// `store` is what lets a session survive across requests: without one every
// `agent.session({ id })` the handler opens gets a fresh in-memory transcript,
// so a second turn forgets the first and `GET /chat/:id` returns empty.
const agent = createAgent({
  model: 'openai/gpt-4o-mini',
  instructions: 'You are helpful.',
  store: memoryStore(), // lives in the server process; use a durable store on serverless
});

export const { GET, POST } = createRouteHandler(agent, {
  basePath: '/api/agent',
  auth: process.env.AGENT_TOKEN,
  uiMessageStream: true,
});
export {};
