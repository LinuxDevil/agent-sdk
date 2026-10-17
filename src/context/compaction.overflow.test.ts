import { describe, it, expect } from 'vitest';
import {
  createCompactionHook,
  markContextOverflow,
  observedContextWindow,
} from './compaction';
import type { GenerateOptions, Message } from '../providers';
import { textOf } from '../providers';
import { estimateTokens } from '../models';
import { HookRegistry } from '../execution/hooks';
import { shouldSurfaceToModel } from '../execution/generateStep';
import type { ExecuteOptions } from '../execution/AgentExecutor';
import type { CompactedProviderError } from '../execution/errors';

const BIG = 'x'.repeat(4_000); // about 1,000 tokens

/** system, user, then `rounds` of assistant tool call + its (large) result. */
function transcript(rounds: number): Message[] {
  const messages: Message[] = [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'start' },
  ];
  for (let i = 1; i <= rounds; i++) {
    const id = `call_${i}`;
    messages.push({
      role: 'assistant',
      content: '',
      toolCalls: [{ id, type: 'function', function: { name: 'search', arguments: '{}' } }],
    });
    messages.push({ role: 'tool', toolCallId: id, toolName: 'search', content: `${i}:${BIG}` });
  }
  return messages;
}

const isMarker = (m: Message) => /^\[pruned: [\s\S]* result, \d+ chars[\s\S]*\]$/.test(textOf(m));

function request(messages: Message[], model = 'compaction-test-model'): GenerateOptions {
  return { model, messages };
}

async function runHook(hook = createCompactionHook(), req = request(transcript(10))) {
  const hooks = new HookRegistry();
  hooks.register(hook);
  const before = req.messages;
  await hooks.runPreGenerate({ messages: req.messages, request: req });
  expect(req.messages).toBe(before); // rewritten in place, never replaced
  return req;
}

describe('observedContextWindow', () => {
  it('reads the window llama.cpp / LM Studio name in the error', () => {
    expect(observedContextWindow('the request (12000 tokens) exceeds the available context size (8192 tokens)')).toBe(8_192);
    expect(observedContextWindow('n_ctx = 4096')).toBe(4_096);
    expect(observedContextWindow("This model's maximum context length is 8192 tokens")).toBe(8_192);
    expect(observedContextWindow('maximum sequence length is 16,384 tokens')).toBe(16_384);
    expect(observedContextWindow('rate limit reached')).toBeUndefined();
  });
});

describe('server-side context overflow', () => {
  it('compacts under the window the server reported, not the configured one', async () => {
    // ~10K tokens of transcript: under the (wrong) configured 32K window,
    // over the real 8K window the server just reported.
    const req = request(transcript(10));
    markContextOverflow(req.messages, 8_192);
    const result = await runHook(createCompactionHook({ contextWindow: 32_768, protectedTokens: 1_000 }), req);
    expect(result.messages.filter(isMarker).length).toBeGreaterThan(0);
    expect(estimateTokens(result.messages)).toBeLessThan(estimateTokens(transcript(10)));
  });

  it('leaves the same transcript alone without the mark', async () => {
    const result = await runHook(createCompactionHook({ contextWindow: 32_768, protectedTokens: 1_000 }), request(transcript(10)));
    expect(result.messages.filter(isMarker)).toHaveLength(0);
  });

  it('uses the rejected request size as the ceiling when the error named no window', async () => {
    const req = request(transcript(10));
    markContextOverflow(req.messages); // no observed size: the estimate that failed is the ceiling
    const result = await runHook(createCompactionHook({ contextWindow: 32_768, protectedTokens: 1_000 }), req);
    expect(result.messages.filter(isMarker).length).toBeGreaterThan(0);
  });

  it('keeps the smaller window for the rest of the run', async () => {
    const req = request(transcript(10));
    markContextOverflow(req.messages, 8_192);
    // A later, larger report must not loosen the known ceiling.
    markContextOverflow(req.messages, 16_384);
    const result = await runHook(createCompactionHook({ contextWindow: 32_768, protectedTokens: 1_000 }), req);
    expect(result.messages.filter(isMarker).length).toBeGreaterThan(0);
  });
});

describe('shouldSurfaceToModel with a compaction hook', () => {
  const overflow: CompactedProviderError = {
    error: 'context size exceeded',
    category: 'context-length-exceeded',
    retryable: false,
  };
  const optionsWithCompaction = () => {
    const hooks = new HookRegistry();
    hooks.register(createCompactionHook());
    return { hooks } as ExecuteOptions;
  };

  it('retries a context-length-exceeded failure when a compaction hook is installed', () => {
    expect(shouldSurfaceToModel(optionsWithCompaction(), overflow)).toBe(true);
  });

  it('still rejects it without a compaction hook', () => {
    expect(shouldSurfaceToModel({ hooks: new HookRegistry() } as ExecuteOptions, overflow)).toBe(false);
    expect(shouldSurfaceToModel({} as ExecuteOptions, overflow)).toBe(false);
  });

  it('does not retry other categories on the hook alone', () => {
    const rateLimit: CompactedProviderError = { error: 'slow down', category: 'rate-limit', retryable: true };
    expect(shouldSurfaceToModel(optionsWithCompaction(), rateLimit)).toBe(false);
  });
});
