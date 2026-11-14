import { z } from 'zod';
import { defineTool } from '../../../../../../tools/defineTool';

export default defineTool({
  name: 'synthesize_voice',
  description: 'Mock voice synthesis that returns a placeholder audio artifact',
  input: z.object({ script: z.string() }),
  execute: ({ script }) => ({ artifact: 'placeholder.mp3', bytes: script.length }),
});
