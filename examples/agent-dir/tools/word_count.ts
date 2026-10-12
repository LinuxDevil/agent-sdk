import { z } from 'zod';
import { defineTool } from '@lousho/build-ai-agent';

export default defineTool({
  name: 'word_count',
  description: 'Count the words in a piece of text',
  input: z.object({ text: z.string() }),
  execute: ({ text }) => ({ words: text.split(/\s+/).filter(Boolean).length }),
});
