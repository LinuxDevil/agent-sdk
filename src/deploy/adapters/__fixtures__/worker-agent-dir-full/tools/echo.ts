import { z } from 'zod';
import { defineTool } from '@lousho/build-ai-agent';

// The registry's mock provider calls a tool the user message names, with { input: 'mock input' }.
export default defineTool({
  name: 'echo',
  description: 'Echoes its input back',
  input: z.object({ input: z.string() }),
  execute: ({ input }) => `echo: ${input}`,
});
