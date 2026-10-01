import { z } from 'zod';
import { defineTool } from '../../../../tools/defineTool';

export default defineTool({
  name: 'echo',
  description: 'Echo the text back',
  input: z.object({ text: z.string() }),
  execute: ({ text }) => `echo: ${text}`,
});
