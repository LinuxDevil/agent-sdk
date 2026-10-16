import { z } from 'zod';
import { defineTool } from '@lousho/build-ai-agent';

// The registry's mock provider calls a tool the user message names, with { input: 'mock input' }.
export default defineTool({
  name: 'submit_expense',
  description: 'Files an expense claim',
  input: z.object({ input: z.string() }),
  needsApproval: true,
  execute: () => 'claim filed',
});
