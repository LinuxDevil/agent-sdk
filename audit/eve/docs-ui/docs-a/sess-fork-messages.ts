// sessions.md:321-357: fork() "keeps the transcript up to and including the step" — check what the returned session exposes
import { createAgent, defineTool } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';
import { z } from 'zod';
const searchFlights = defineTool({ name: 'search_flights', description: 'Find flights to a city', input: z.object({ to: z.string() }), execute: async ({ to }) => `2 flights to ${to}` });
const agent = createAgent({ tools: [searchFlights], provider: mockModel([{ toolCalls: [{ name: 'search_flights', args: { to: 'Lisbon' } }] }, 'Two flights to Lisbon on Friday.', 'Porto has a direct flight at 9:00.']) });
const session = agent.session({ id: 'trip' });
await session.send('Find me a flight to Lisbon on Friday.');
const fork = await session.fork({ fromStep: 1 });
console.log('fork.messages right after fork():', fork.messages.length, '| fork.history():', (await fork.history()).length);
await fork.load();
console.log('after fork.load():', fork.messages.map((m: any) => m.role).join(','));
