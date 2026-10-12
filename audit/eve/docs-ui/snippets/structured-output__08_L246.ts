// structured-output.md:246
import { z } from 'zod';
import { createAgent } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';

const agent = createAgent({ provider: mockModel(['{"city":"Paris","tempC":21}']), output: z.object({ city: z.string(), tempC: z.number() }) });
const { object } = await agent.send('Weather in Paris?');
console.log(object?.city); // 'Paris'
export {};
