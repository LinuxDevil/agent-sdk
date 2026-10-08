/**
 * Repro: llmJudge() with a local reasoning model as judge. Logs the raw judge
 * text next to the parsed score, plus parseJudgeScore() on common judge formats.
 */
import { llmJudge, parseJudgeScore, type ExecutionResult, type LLMProvider } from '@lousho/build-ai-agent';
import { localProvider, LOCAL_MODEL } from '../../_shared/local.js';

for (const s of ['0.9', '0.9\n\nThe answer is correct.', 'Score: 0.9', '**0.9**', '9/10', '1.0 (fully correct)', '<think>ok</think>0.8'])
  console.log(`parseJudgeScore(${JSON.stringify(s)}) ->`, parseJudgeScore(s));

const base = localProvider();
const raw: string[] = [];
const logging = { ...base, name: base.name, defaultModel: base.defaultModel, supportsTools: () => true, supportsStreaming: () => true, getModels: () => base.getModels(), stream: (o: any) => base.stream(o),
  generate: async (o: any) => { const r = await base.generate(o); raw.push(r.text); return r; } } as LLMProvider;

const good = { text: 'Use recordReplay() from @lousho/build-ai-agent/testing: record once with mode "record" against the real provider, commit the cassette, and replay it in CI with no API key.' } as ExecutionResult;
const bad = { text: 'Set OPENAI_API_KEY in CI; there is no way to avoid calling the model.' } as ExecutionResult;
const judge = llmJudge({ provider: logging, model: LOCAL_MODEL, temperature: 0, allowOutsideJudgeRunner: true,
  rubric: 'Question: "How do I record real model calls once and replay them in CI without an API key?" Score 1 if correct and specific, 0 if wrong.' });
for (const [name, r] of [['good', good], ['bad', bad], ['good', good]] as const) {
  const score = await judge(r);
  console.log(`${name}: score=${score} raw=${JSON.stringify(raw.at(-1)?.slice(0, 160))}`);
}
