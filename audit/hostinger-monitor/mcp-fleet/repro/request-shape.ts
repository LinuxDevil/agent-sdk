// What does the SDK actually send to LM Studio for a tool step of an agent with `output`? (fetch is wrapped to log the body shape)
import { createAgent, defineTool } from '@lousho/build-ai-agent';
import { z } from 'zod';
import { localProvider } from '../../../_shared/local.js';
import { FleetReportSchema } from '../schema.js';
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init: any) => {
  const body = JSON.parse(init.body);
  console.log('POST', String(url), 'keys=', Object.keys(body).join(','), '| max_tokens=', body.max_tokens ?? body.max_completion_tokens, '| response_format=', JSON.stringify(body.response_format)?.slice(0, 80), '| tool_choice=', body.tool_choice, '| tools=', body.tools?.length);
  const res = await realFetch(url, init);
  console.log('  -> HTTP', res.status);
  return res;
}) as any;
const t = defineTool({ name: 'list_vms', description: 'list vms', input: z.object({}), execute: async () => [{ id: 1, state: 'running' }] });
const agent = createAgent({ provider: localProvider(), instructions: 'Call list_vms then report.', tools: [t], output: FleetReportSchema, maxSteps: 3, retry: false });
try {
  const r = await agent.send('Report.');
  console.log('finish', r.finishReason, JSON.stringify(r.object)?.slice(0, 200));
} catch (e: any) {
  console.log('threw', e.code, String(e.message).slice(0, 120));
}
