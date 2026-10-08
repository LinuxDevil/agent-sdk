/**
 * Repro: llmJudge() invoked outside the judge-eval runner must throw
 * LOUSHO_EVALS_INVALID before making any model call. Offline — the guard
 * fires before provider.generate(). Run: npx tsx research-analyst/repro/judge-guard.ts
 */
import '../../_shared/env.js';
import { llmJudge, resolveProvider, type ExecutionResult } from '@lousho/build-ai-agent';
import { LIVE_MODEL } from '../../_shared/env.js';

const scorer = llmJudge({
  provider: resolveProvider(LIVE_MODEL),
  model: LIVE_MODEL.split('/').slice(1).join('/'),
  rubric: 'anything',
  // NOTE: allowOutsideJudgeRunner deliberately unset -> must throw
});

const fake = { text: 'report', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, modelCalls: 0, estimated: false, byModel: {}, promptTokens: 0, completionTokens: 0 }, finishReason: 'stop', steps: 1, toolCalls: [], messages: [] } as unknown as ExecutionResult;

try {
  await scorer(fake);
  console.log('[FAIL] judge-guard :: scorer ran outside judge runner (no throw)');
} catch (error) {
  const e = error as Error & { code?: string };
  console.log(`[${e.code === 'LOUSHO_EVALS_INVALID' ? 'PASS' : 'FAIL'}] judge-guard :: ${e.name} code=${e.code} :: ${e.message.slice(0, 120)}`);
}
