import { z } from 'zod';
import { defineTool } from '../../../../../../tools/defineTool';

export default defineTool({
  name: 'search_facts',
  description: 'Mock fact search that returns a placeholder fact',
  input: z.object({ query: z.string() }),
  execute: ({ query }) => ({ fact: `placeholder fact about ${query}` }),
});
