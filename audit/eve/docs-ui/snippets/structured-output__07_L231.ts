// structured-output.md:231
import { z } from 'zod';
import { AgentBuilder, AgentExecutor } from '@lousho/build-ai-agent/executor';
import { createMockProvider } from '@lousho/build-ai-agent';

const Ticket = z.object({ title: z.string(), priority: z.enum(['low', 'high']) });
const agent = AgentBuilder.create().setName('triage').setPrompt('You triage bug reports.').build();
const result = await AgentExecutor.execute({ agent, input: 'The app crashes on login', provider: createMockProvider(), output: Ticket });
const ticket = result.object === undefined ? undefined : Ticket.parse(result.object);
export {};
