import { defineTool } from '@lousho/build-ai-agent';
import { z } from 'zod';
export default defineTool({
  name: 'write_file', description: 'Write a file', input: z.object({ path: z.string() }),
  execute: async ({ path }) => { (globalThis as any).__eveWrites = [...((globalThis as any).__eveWrites ?? []), path]; return 'written'; },
});
