// Probe: how often does a trivial one-sentence request blow LM Studio's 8k context, by reasoning setting?
import { createAgent } from '@lousho/build-ai-agent';
import { localProvider } from '../../_shared/local.js';
const variants: Array<[string, Record<string, unknown>, string]> = [
  ['default', {}, 'Be terse.'],
  ['effort low (force)', { reasoning: { effort: 'low', force: true } }, 'Be terse.'],
  ['/no_think in prompt', {}, '/no_think Be terse.'],
];
for (const [label, extra, instructions] of variants) {
  for (let i = 0; i < 2; i++) {
    const t0 = Date.now();
    let reasoningChars = 0;
    try {
      const run = createAgent({ provider: localProvider(), instructions, ...extra }).stream('A customer says the shoes do not fit. Reply in one sentence.');
      for await (const e of run) if (e.type === 'reasoning.delta') reasoningChars += e.text.length;
      const r = await run.result;
      console.log(label, `#${i}`, Date.now() - t0, 'ms reasoningChars', reasoningChars, 'tokens', r.usage?.totalTokens, JSON.stringify(r.text.slice(0, 60)));
    } catch (e) {
      console.log(label, `#${i}`, Date.now() - t0, 'ms reasoningChars', reasoningChars, 'FAILED', (e as Error).message.slice(0, 90));
    }
  }
}
