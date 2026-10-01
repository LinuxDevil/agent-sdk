import { z } from 'zod';
import { defineTool } from '../../../../tools/defineTool';

export default defineTool({
  name: 'ping',
  description: 'Reply with pong',
  input: z.object({}),
  execute: () => 'pong',
});
