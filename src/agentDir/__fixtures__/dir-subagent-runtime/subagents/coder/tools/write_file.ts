import { z } from 'zod';
import { defineTool } from '../../../../../../tools/defineTool';

const g = globalThis as { __dirSubagentWrites?: string[] };

export default defineTool({
  name: 'write_file',
  description: 'Write a file',
  input: z.object({ path: z.string() }),
  execute: ({ path }) => {
    g.__dirSubagentWrites = [...(g.__dirSubagentWrites ?? []), path];
    return 'written';
  },
});
