/**
 * Repro: does a reasoning model behind an OpenAI-compatible baseURL (LM Studio)
 * surface its reasoning through OpenAIProvider, and does recordReplay keep it?
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { recordReplay } from '@lousho/build-ai-agent/testing';
import { localProvider, LOCAL_BASE_URL, LOCAL_MODEL } from '../../_shared/local.js';

const messages = [{ role: 'user' as const, content: 'Is 17 prime? Answer yes or no.' }];
const raw = await (await fetch(`${LOCAL_BASE_URL}/chat/completions`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: LOCAL_MODEL, messages, max_tokens: 600 }),
})).json() as any;
const m = raw.choices[0].message;
console.log('raw HTTP: content=%j reasoning_content chars=%d usage=%j', m.content?.slice(0, 80), (m.reasoning_content ?? m.reasoning ?? '').length, raw.usage);

const p = localProvider();
const live = await p.generate({ messages, maxTokens: 600 });
console.log('OpenAIProvider.generate: text=%j reasoning blocks=%d usage=%j', live.text.slice(0, 80), live.reasoning?.length ?? 0, live.usage);

const s = await p.stream({ messages, maxTokens: 600 });
const types: Record<string, number> = {};
for await (const c of s.fullStream) types[c.type] = (types[c.type] ?? 0) + 1;
console.log('OpenAIProvider.stream chunk types:', types);

const cassette = path.join(os.tmpdir(), `reasoning-${process.pid}.json`);
const rec = recordReplay(p, { cassette, mode: 'record' });
const recorded = await rec.generate({ messages, maxTokens: 600 });
const play = recordReplay(undefined, { cassette, mode: 'replay' });
const replayed = await play.generate({ messages, maxTokens: 600 });
console.log('record: reasoning blocks=%d usage=%j', recorded.reasoning?.length ?? 0, recorded.usage);
console.log('replay: reasoning blocks=%d usage=%j', replayed.reasoning?.length ?? 0, replayed.usage);
fs.rmSync(cassette, { force: true });
