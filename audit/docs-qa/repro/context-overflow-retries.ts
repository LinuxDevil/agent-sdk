/** Counts the HTTP requests behind one context-overflow failure (global fetch wrapper). */
import { createAgent } from '@lousho/build-ai-agent';
import { localProvider } from '../../_shared/local.js';

let http = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (...a: Parameters<typeof fetch>) => { http++; const r = await realFetch(...a); console.log(`  HTTP #${http} -> ${r.status}`); return r; }) as typeof fetch;
const agent = createAgent({ provider: localProvider(), prompt: 'Summarize.' });
try { await agent.send('lorem ipsum dolor sit amet '.repeat(9000)); } catch (e: any) {
  console.log(`threw: category=${e.compacted?.category} retryable=${e.compacted?.retryable}; HTTP requests made: ${http}`);
}
