import { z } from 'zod';
import { defineTool } from '../defineTool';
import { ToolDescriptor } from '../../types';

/**
 * Day Name Tool
 * Returns the name of the day for a given date
 */
export const dayNameTool: ToolDescriptor = defineTool({
  name: 'day_name',
  annotations: { readOnlyHint: true, destructiveHint: false },
  displayName: 'Get day name',
  description: 'Get the name of the day (e.g., Monday, Tuesday) for a given date',
  input: z.object({
    date: z.string().describe('The date to get the day name for in ISO format (e.g., 2024-01-15)'),
    locale: z.string().optional().describe('The locale to use for the day name (e.g., en-US, pl-PL). Defaults to en-US'),
  }),
  execute: async ({ date, locale = 'en-US' }) => {
    return new Date(date).toLocaleDateString(locale, { weekday: 'long' });
  },
});
