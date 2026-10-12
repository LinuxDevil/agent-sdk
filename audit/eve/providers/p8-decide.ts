// P8 (offline): decide() edge cases with an injected fetch.
// Run: npx tsx eve/providers/p8-decide.ts
import { decide } from '@lousho/build-ai-agent';
import { report } from '../../_shared/env.ts';

const questions = [
  { type: 'choice' as const, name: 'route', instructions: 'Which team?', choices: [{ value: 'billing' }, { value: 'shipping' }] },
  { type: 'predicate' as const, name: 'angry', instructions: 'Is the customer angry?' },
];

// 1. caller cancels -> what does the caller see?
{
  const ac = new AbortController();
  const hang: typeof fetch = (_u, init) =>
    new Promise((_r, rej) => init!.signal!.addEventListener('abort', () => rej(init!.signal!.reason)));
  setTimeout(() => ac.abort(), 50);
  try {
    await decide({ input: 'x', questions, apiKey: 'k', fetch: hang, signal: ac.signal });
  } catch (e: any) {
    console.log('user abort ->', e.name, e.code, JSON.stringify(e.message.split('\n')[0]));
    report('a user cancel surfaces as an AbortError (like agent.send)', e.name === 'AbortError', `got ${e.name}/${e.code}`);
  }
}

// 2. server answers a different question set / an out-of-range choice / drops one -> accepted?
{
  const lying: typeof fetch = async () =>
    new Response(JSON.stringify({ answers: [{ type: 'choice', name: 'route', choice: 'legal', probabilities: [], confidence: 0.9 }] }), { status: 200 });
  const r = await decide({ input: 'x', questions, apiKey: 'k', fetch: lying });
  console.log('answers:', JSON.stringify(r.answers));
  report('decide() rejects a choice outside `choices` and a missing answer', false, 'returned {choice:"legal"} and no `angry` answer without error');
}

// 3. 429 -> retried?
{
  let n = 0;
  const limited: typeof fetch = async () => {
    n++;
    return new Response('{"error":{"message":"Rate limit"}}', { status: 429, headers: { 'retry-after': '1' } });
  };
  try {
    await decide({ input: 'x', questions, apiKey: 'k', fetch: limited });
  } catch (e: any) {
    report('decide() retries a 429 like the agent path does', n > 1, `calls=${n} code=${e.code}`);
  }
}
