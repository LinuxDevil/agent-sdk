// CORE: deterministic - "Stop" while the model is answering a session turn erases the user's message from the transcript.
// Run: npx tsx eve/core/r18-session-abort-midmodel.ts
import { createAgent, memoryStore, type LLMProvider } from '@lousho/build-ai-agent';
let call = 0;
const provider = {
  name: 'slowish',
  defaultModel: 'm',
  async generate(opts: any) {
    call++;
    if (call === 1) return { text: 'Hi Ali.', finishReason: 'stop', usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 } };
    if (call === 2) {
      // a signal-honouring provider that takes 1s to answer
      await new Promise((res, rej) => { const t = setTimeout(res, 1000); opts.signal?.addEventListener('abort', () => { clearTimeout(t); rej(opts.signal.reason); }); });
      return { text: 'never', finishReason: 'stop', usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 } };
    }
    const users = opts.messages.filter((m: any) => m.role === 'user').map((m: any) => m.content);
    return { text: `user messages I can see: ${JSON.stringify(users)}`, finishReason: 'stop', usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 } };
  },
} as unknown as LLMProvider;
const agent = createAgent({ provider, store: memoryStore() });
const s = agent.session({ id: 'stop-midmodel' });
await s.send('My name is Ali.');
const r2 = await s.send('Please summarise contract #A-7 for me.', { signal: AbortSignal.timeout(100) });
console.log('turn 2 finishReason=%s', r2.finishReason);
console.log('transcript after Stop: %j', (await s.load()).map((m: any) => `${m.role}: ${m.content}`));
const r3 = await s.send('Go on, continue.');
console.log('turn 3: %s', r3.text);
