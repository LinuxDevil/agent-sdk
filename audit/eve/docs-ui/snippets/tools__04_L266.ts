// tools.md:266
import { ToolRegistry } from '@lousho/build-ai-agent/tools';
import { currentDateTool, defineTool } from '@lousho/build-ai-agent';
import { z } from 'zod';

const lookupOrder = defineTool({
  name: 'lookup_order',
  description: 'Look up an order',
  input: z.object({ orderId: z.string() }),
  execute: async ({ orderId }) => ({ orderId, status: 'shipped' }),
});

const tools = new ToolRegistry();
tools.register(lookupOrder);
tools.register('current_date', currentDateTool);
export {};
