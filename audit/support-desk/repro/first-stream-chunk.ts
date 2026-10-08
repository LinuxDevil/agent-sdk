/**
 * Probe for F8: the first chunks of OpenAIProvider.stream() against LM Studio
 * when the server answers with an in-stream 500.
 *
 *   npx tsx support-desk/repro/first-stream-chunk.ts
 */
import { localProvider, LOCAL_MODEL } from '../../_shared/local.js';

const provider = localProvider();
for (let i = 0; i < 3; i++) {
  const streamed = await provider.stream({
    model: LOCAL_MODEL,
    messages: [{ role: 'system', content: 'Be terse.' }, { role: 'user', content: 'A customer says the shoes do not fit. Reply in one sentence.' }],
  } as never);
  const seen: string[] = [];
  try {
    for await (const chunk of streamed.fullStream) {
      seen.push(chunk.type + (chunk.textDelta !== undefined ? `(${JSON.stringify(chunk.textDelta.slice(0, 10))})` : ''));
      if (seen.length > 4) break;
    }
  } catch (error) {
    seen.push(`THROW ${(error as Error).message.slice(0, 60)}`);
  }
  console.log(seen.join(' | '));
}
