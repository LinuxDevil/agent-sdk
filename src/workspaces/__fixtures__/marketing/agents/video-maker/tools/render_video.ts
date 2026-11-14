import { z } from 'zod';
import { defineTool } from '../../../../../../tools/defineTool';

export default defineTool({
  name: 'render_video',
  description: 'Mock renderer that returns a placeholder video artifact',
  input: z.object({ script: z.string() }),
  execute: ({ script }) => ({ artifact: 'placeholder.mp4', bytes: script.length }),
});
