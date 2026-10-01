import { z } from 'zod';
import { defineTool } from '../defineTool';
import { ToolDescriptor } from '../../types';

/**
 * Current Date Tool
 * Returns the current date in ISO format
 */
export const currentDateTool: ToolDescriptor = defineTool({
  name: 'current_date',
  annotations: { readOnlyHint: true, destructiveHint: false },
  displayName: 'Get current date',
  description: 'Get the current date and time in ISO format (UTC timezone)',
  input: z.object({}),
  execute: async () => {
    return new Date().toISOString();
  },
});
