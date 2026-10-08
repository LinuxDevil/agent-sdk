// Repro: the Chat Completions fallback (fromAiSdk(openai.chat)) with the invoice schema -> 400. What did the server say,
// and what does the SDK error carry?
import { readFileSync } from 'node:fs';
import { createAgent, fromAiSdk } from '@lousho/build-ai-agent';
import { createOpenAI } from '@ai-sdk/openai';
import { startProxy } from './proxy.js';
import { LOCAL_MODEL } from '../../_shared/local.js';
import { Extraction } from '../schema.js';
import { EXTRACT_INSTRUCTIONS } from '../pipeline.js';

const proxy = await startProxy(1242, { keepResponses: true });
const provider = fromAiSdk(createOpenAI({ apiKey: 'lm-studio', baseURL: proxy.url }).chat(LOCAL_MODEL));
const agent = createAgent({ provider, instructions: EXTRACT_INSTRUCTIONS, output: Extraction, retry: false });
try {
  const r = await agent.send('Document id inv-01:\n\n' + readFileSync(new URL('../fixtures/inv-01-acme-us.txt', import.meta.url), 'utf8'));
  console.log('ok', r.finishReason, JSON.stringify(r.object).slice(0, 300));
} catch (e: any) {
  console.log('THREW', e.constructor.name, 'code', e.code, 'category', e.category, 'status', e.statusCode, 'message:', JSON.stringify(e.message));
  console.log('error own keys:', Object.keys(e));
}
for (const e of proxy.log) {
  console.log('wire', e.path, e.status, 'response_format:', JSON.stringify(e.body.response_format)?.slice(0, 160));
  if (e.status !== 200) console.log('server said:', e.responseText);
}
proxy.close();
