// Repro: on an 8k-context local reasoning model, can the SDK's `reasoning` option keep thinking short enough for
// a structured extraction to fit? Measures tokens / time / outcome per setting, and what the wire carries.
import { readFileSync } from 'node:fs';
import { createAgent, OpenAIProvider } from '@lousho/build-ai-agent';
import { startProxy } from './proxy.js';
import { LOCAL_MODEL } from '../../_shared/local.js';
import { Extraction } from '../schema.js';
import { EXTRACT_INSTRUCTIONS } from '../pipeline.js';

const proxy = await startProxy(1243, { keepResponses: true });
const provider = new OpenAIProvider({ apiKey: 'lm-studio', baseURL: proxy.url, defaultModel: LOCAL_MODEL, maxRetries: 0 });
const doc = 'Document id inv-01:\n\n' + readFileSync(new URL('../fixtures/inv-01-acme-us.txt', import.meta.url), 'utf8');
const which = process.argv[2];
const settings: Record<string, any> = {
  default: {},
  'effort-low': { reasoning: 'low' },
  'effort-low-force': { reasoning: { effort: 'low', force: true } },
  'effort-none-force': { reasoning: { effort: 'none', force: true } },
};
for (const [label, extra] of Object.entries(settings)) {
  if (which && which !== label) continue;
  const before = proxy.log.length;
  const t0 = Date.now();
  try {
    const r = await createAgent({ provider, instructions: EXTRACT_INSTRUCTIONS, output: Extraction, retry: false, ...extra }).send(doc);
    console.log(`[${label}] ${Date.now() - t0}ms finish=${r.finishReason} steps=${r.steps} in=${r.usage.inputTokens} out=${r.usage.outputTokens} reasoning=${r.usage.reasoningTokens} total=${(r.object as any)?.document?.total}`);
  } catch (e: any) {
    console.log(`[${label}] ${Date.now() - t0}ms THREW ${e.code} status=${e.statusCode} message=${JSON.stringify(e.message)} detail=${JSON.stringify(e.detail)?.slice(0, 200)}`);
  }
  for (const e of proxy.log.slice(before)) console.log('   wire', e.status, 'reasoning=', JSON.stringify(e.body.reasoning), 'resp:', e.status !== 200 ? e.responseText?.slice(0, 200) : '');
}
proxy.close();
