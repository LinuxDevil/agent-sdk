// sessions.md:328
import { createAgent, defineTool } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';
import { z } from 'zod';

const searchFlights = defineTool({
  name: 'search_flights',
  description: 'Find flights to a city',
  input: z.object({ to: z.string() }),
  execute: async ({ to }) => `2 flights to ${to}`,
});
const agent = createAgent({
  tools: [searchFlights],
  provider: mockModel([
    { toolCalls: [{ name: 'search_flights', args: { to: 'Lisbon' } }] },
    'Two flights to Lisbon on Friday.',
    'Porto has a direct flight at 9:00.',
  ]),
});
const session = agent.session({ id: 'trip' });
await session.send('Find me a flight to Lisbon on Friday.');

for (const { step, turn, text, toolCalls } of await session.history()) {
  console.log(step, turn, text, toolCalls.map((call) => `${call.name} -> ${call.result}`));
}

// Keep everything up to and including step 1, then go another way.
const fork = await session.fork({ fromStep: 1 }); // saved in the same store
const reply = await fork.send('Look at Porto instead.');
console.log(fork.id, reply.text); // 'trip-fork-1', 'Porto has a direct flight at 9:00.'
export {};
