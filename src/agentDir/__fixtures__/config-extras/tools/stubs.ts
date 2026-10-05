import { z } from 'zod';
import { defineTool } from '../../../../tools/defineTool';

export const readFile = defineTool({
  name: 'read_file',
  description: 'Read a file',
  input: z.object({ path: z.string() }),
  execute: ({ path }) => `contents of ${path}`,
});

export const writeFile = defineTool({
  name: 'write_file',
  description: 'Write a file',
  input: z.object({ path: z.string() }),
  execute: ({ path }) => `wrote ${path}`,
});

export const shell = defineTool({
  name: 'shell',
  description: 'Run a command',
  input: z.object({ command: z.string() }),
  execute: ({ command }) => `ran: ${command}`,
});
