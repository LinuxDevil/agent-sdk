/**
 * Eve audit repro: stream boundary asymmetry — withFallback commits after the
 * first chunk even when it is only reasoning; withRetry treats reasoning as
 * uncommitted. A stream that yields reasoning then errors: does each retry?
 * Run: npx tsx audit/eve/repro-stream.ts
 */
import { withFallback, withRetry } from '../../src/providers/resilience';
import type { LLMProvider, StreamResult, StreamChunk } from '../../src/providers/llm';

const TIMEOUT = new Error('The request timed out'); // classifies 'timeout' -> retryable

function flakyStream(): AsyncGenerator<StreamChunk> {
  return (async function* () {
    yield { type: 'reasoning-delta', textDelta: 'thinking...' };
    yield { type: 'error', error: TIMEOUT };
  })();
}
function cleanStream(): AsyncGenerator<StreamChunk> {
  return (async function* () {
    yield { type: 'text-delta', textDelta: 'ok' };
    yield { type: 'finish', finishReason: 'stop' };
  })();
}

function provider(name: string, make: () => AsyncGenerator<StreamChunk>): LLMProvider {
  const stream = async (): Promise<StreamResult> => {
    const full = make();
    return {
      fullStream: full,
      textStream: (async function* () { for await (const c of full) if (c.type === 'text-delta' && c.textDelta) yield c.textDelta; })(),
      text: Promise.resolve(''),
      usage: Promise.resolve(undefined),
      finishReason: Promise.resolve('stop'),
      toolCalls: Promise.resolve([]),
    };
  };
  return { name, generate: async () => ({ text: '', finishReason: 'error' as const }), stream, supportsTools: () => true, supportsStreaming: () => true, getModels: async () => ['x'] };
}

const fast = { maxRetries: 1, backoff: { initialMs: 1, maxMs: 2, jitter: false } };

// 1) withRetry: reasoning-delta then error -> expect retry, 'ok' delivered
{
  let calls = 0;
  const p = provider('flaky', () => (calls++ === 0 ? flakyStream() : cleanStream()));
  const out: string[] = [];
  for await (const c of (await withRetry(p, fast).stream({ messages: [] })).fullStream) out.push(c.type);
  console.log('withRetry chunks:', out.join(','), '| calls:', calls);
}

// 2) withFallback (no inner retry): committed on first chunk even if reasoning-only?
{
  let callsA = 0, callsB = 0;
  const a = provider('a', () => (callsA++, flakyStream()));
  const b = provider('b', () => (callsB++, cleanStream()));
  const out: string[] = [];
  try {
    for await (const c of (await withFallback([a, b]).stream({ messages: [] })).fullStream) out.push(c.type);
  } catch (e) { out.push(`THREW:${(e as Error).message}`); }
  console.log('withFallback chunks:', out.join(','), '| a calls:', callsA, '| b calls:', callsB);
}
