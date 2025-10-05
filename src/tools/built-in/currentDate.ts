import { z } from 'zod';
import { tool } from 'ai';
import { ToolDescriptor } from '../../types';

/**
 * Current Date Tool
 * Returns the current date in ISO format
 */
export const currentDateTool: ToolDescriptor = {
  displayName: 'Get current date',
  tool: tool({
    description: 'Get the current date and time in ISO format (UTC timezone)',
    parameters: z.object({}),
    execute: async () => {
      return new Date().toISOString();
    },
  }),
};
