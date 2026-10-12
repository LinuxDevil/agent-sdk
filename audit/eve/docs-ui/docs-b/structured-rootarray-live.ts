import { z } from 'zod';
import { createAgent } from '@lousho/build-ai-agent';
import { LIVE_MODEL, hasLiveKey } from '../../../_shared/env.ts';
if (!hasLiveKey) { console.log('no key'); process.exit(0); }
const agent = createAgent({ model: LIVE_MODEL, output: z.array(z.object({ city: z.string() })) });
try {
  const r = await agent.send('List two French cities.');
  console.log(JSON.stringify({ fr: r.finishReason, obj: r.object, text: r.text?.slice(0, 200), err: r.outputError?.message?.slice(0, 200), steps: r.steps?.length }));
} catch (e: any) { console.log('THROW', e.name, e.code, String(e.message).slice(0, 300)); }
