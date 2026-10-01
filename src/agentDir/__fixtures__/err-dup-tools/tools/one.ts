import { z } from 'zod';
import { defineTool } from '../../../../tools/defineTool';

export default defineTool({
  name: 'same_name',
  description: 'First',
  input: z.object({}),
  execute: () => 1,
});
