import { z } from 'zod';
import { defineTool } from '../../../../tools/defineTool';

export const add = defineTool({
  name: 'add',
  description: 'Add two numbers',
  input: z.object({ a: z.number(), b: z.number() }),
  execute: ({ a, b }) => a + b,
});

export const double = defineTool({
  name: 'double',
  description: 'Double a number',
  input: z.object({ n: z.number() }),
  execute: ({ n }) => n * 2,
});

export const notATool = 'helpers can live in the same file';
