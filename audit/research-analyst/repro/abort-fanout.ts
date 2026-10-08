/**
 * Repro (live, ~1 model call before the abort lands): a coordinator fans
 * out 2 researcher tasks in one turn; the caller aborts mid-flight with
 * AbortSignal.timeout. Checks the run resolves (not rejects) with
 * finishReason 'aborted', and whether usage of the killed children still
 * rolls into result.usage.delegated.
 * Run: npx tsx research-analyst/repro/abort-fanout.ts
 */
import '../../_shared/env.js';
import { createAgent, formatUsage } from '@lousho/build-ai-agent';
import { hasLiveKey, LIVE_MODEL, report } from '../../_shared/env.js';

if (!hasLiveKey) {
  report('abort-fanout', false, 'no OPENROUTER_API_KEY');
  process.exit(1);
}

const researcher = createAgent({
  name: 'researcher',
  description: 'Researches one slice.',
  instructions: 'You write long detailed research briefs. Take your time.',
  model: LIVE_MODEL,
});

const coordinator = createAgent({
  name: 'coordinator',
  instructions:
    'Delegate exactly 2 slices to the researcher with the task tool — both task calls in ONE response. Then summarize.',
  model: LIVE_MODEL,
  subagents: { researcher },
  maxSteps: 6,
});

const result = await coordinator.send(
  'Research "Node.js memory pressure" via 2 slices: GC behavior; event-loop impact.',
  { signal: AbortSignal.timeout(4_000) }
);

const delegated = result.usage.delegated;
report(
  'abort mid-fan-out resolves, not rejects',
  result.finishReason === 'aborted',
  `finishReason=${result.finishReason} steps=${result.steps} ${formatUsage(result.usage)} delegated=${JSON.stringify(delegated)}`
);
report(
  'delegated usage kept for killed children',
  delegated !== undefined && delegated.runs >= 0,
  delegated ? `runs=${delegated.runs} modelCalls=${delegated.modelCalls} tokens=${delegated.totalTokens}` : 'no delegated usage recorded'
);
