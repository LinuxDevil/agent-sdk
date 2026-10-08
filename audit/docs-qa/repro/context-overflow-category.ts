/**
 * Repro: LM Studio / llama.cpp reports context overflow as
 * HTTP 500 "Context size has been exceeded." The SDK does not classify it as
 * context-length-exceeded, so it is treated as a retryable server error.
 */
import { createAgent } from '@lousho/build-ai-agent';
import { localProvider } from '../../_shared/local.js';

const huge = 'lorem ipsum dolor sit amet '.repeat(9000); // ~ 50k tokens > 8192 loaded ctx
let calls = 0;
const base = localProvider();
const provider = Object.assign(Object.create(Object.getPrototypeOf(base)), base, {
  generate: (o: any) => { calls++; console.log(`  provider.generate #${calls} at ${new Date().toISOString().slice(11, 19)}`); return base.generate(o); },
  stream: (o: any) => { calls++; console.log(`  provider.stream #${calls}`); return base.stream(o); },
});
const agent = createAgent({ provider, prompt: 'Summarize.' });
const t = Date.now();
try {
  const r = await agent.send(huge);
  console.log('resolved', r.finishReason, r.text.slice(0, 200));
} catch (e: any) {
  console.log(`threw after ${Date.now() - t}ms, ${calls} provider calls`);
  console.log({ name: e.name, code: e.code, compacted: e.compacted, category: e.category, retryable: e.retryable, statusCode: e.statusCode, message: String(e.message).slice(0, 200) });
}

// Second shape: prompt fits, but prompt + generation overflows mid-stream.
const near = 'lorem ipsum dolor sit amet '.repeat(1250); // ~ 7.5k tokens
const agent2 = createAgent({ provider, prompt: 'Repeat the user text back verbatim, then write a long essay about it.' });
calls = 0;
const t2 = Date.now();
try {
  const r = await agent2.send(near);
  console.log('resolved', r.finishReason, r.text.length);
} catch (e: any) {
  console.log(`threw after ${Date.now() - t2}ms, ${calls} provider calls`);
  console.log({ name: e.name, compacted: e.compacted, message: String(e.message).slice(0, 200) });
}
