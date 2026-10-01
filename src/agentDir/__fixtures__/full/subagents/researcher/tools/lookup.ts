import { z } from 'zod';
import { defineTool } from '../../../../../../tools/defineTool';

export default defineTool({
  name: 'lookup',
  description: 'Look up a fact',
  input: z.object({ topic: z.string() }),
  execute: ({ topic }) => `fact about ${topic}`,
});
