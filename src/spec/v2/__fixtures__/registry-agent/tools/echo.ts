import { z } from 'zod';
import { defineTool } from '../../../../../tools/defineTool';

export default defineTool({
  name: 'echo',
  description: 'Echo',
  input: z.object({ text: z.string() }),
  execute: ({ text }) => text,
});
