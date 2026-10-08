/**
 * Docs Q&A bot. Usage:
 *   npx tsx docs-qa/index.ts "How do I ...?"     # one question
 *   npx tsx docs-qa/index.ts --golden [n]        # the golden set (first n), with a quality report
 * Env: DOCSQA_RETRIEVER=sdk|plain (default sdk), DOCSQA_OFFLINE=1 (embedding cache only).
 */
import { buildDocsAgent, checkCitations, type Answer } from './agent.js';
import { GOLDEN, type GoldenCase } from './golden.js';
import { buildRetriever } from './retriever.js';

const args = process.argv.slice(2);
const golden = args[0] === '--golden';
const questions: Array<Pick<GoldenCase, 'input'> & Partial<GoldenCase>> = golden
  ? GOLDEN.slice(0, Number(args[1] ?? GOLDEN.length))
  : [{ input: args.join(' ') || 'How do I record and replay model calls in tests?' }];

const retriever = await buildRetriever();
console.log(`index: ${retriever.chunks.length} chunks via ${retriever.kind} retriever`);

const tally = { completed: 0, object: 0, citedExpected: 0, grounded: 0, keyword: 0, steps: 0, ms: 0 };
for (const q of questions) {
  const { agent, retrieved } = buildDocsAgent({ retriever });
  const started = Date.now();
  let result;
  try {
    result = await agent.send(q.input);
  } catch (error) {
    console.log(`\n### ${q.label ?? 'question'}: THREW ${(error as Error).name}: ${(error as Error).message}`);
    continue;
  }
  const ms = Date.now() - started;
  const obj = result.object as Answer | undefined;
  const cites = checkCitations(obj, retrieved);
  const tools = result.toolCalls.map((c) => `${c.function.name}(${c.function.arguments})`);
  const citedExpected = !!q.expectFiles && !!obj?.citations.some((c) => q.expectFiles!.includes(c.file));
  const keyword = !!q.expectAny && !!obj && q.expectAny.some((w) => obj.answer.toLowerCase().includes(w.toLowerCase()));
  tally.completed += result.finishReason === 'stop' ? 1 : 0;
  tally.object += obj ? 1 : 0;
  tally.citedExpected += citedExpected ? 1 : 0;
  tally.grounded += cites.grounded ? 1 : 0;
  tally.keyword += keyword ? 1 : 0;
  tally.steps += result.steps;
  tally.ms += ms;
  console.log(`\n### ${q.label ?? 'question'} — ${q.input}`);
  console.log(`finish=${result.finishReason} steps=${result.steps} ${ms}ms tokens=${result.usage.totalTokens} reasoningChars=${result.reasoning?.length ?? 0}`);
  console.log(`tools: ${tools.join(' | ')}`);
  if (obj) {
    console.log(`answer: ${obj.answer}`);
    console.log(`citations: ${obj.citations.map((c) => `${c.file}#${c.heading}`).join(', ')}`);
  } else {
    console.log(`NO OBJECT. outputError=${JSON.stringify(result.outputError)} text=${JSON.stringify(result.text.slice(0, 300))}`);
  }
  console.log(`citation check: valid=${cites.valid} invalid=${JSON.stringify(cites.invalid)}${q.expectFiles ? ` citedExpected=${citedExpected} keyword=${keyword}` : ''}`);
}

if (golden) {
  const n = questions.length;
  console.log(
    `\nSUMMARY n=${n} completed=${tally.completed} object=${tally.object} citedExpectedFile=${tally.citedExpected} ` +
      `allCitationsGrounded=${tally.grounded} keywordHit=${tally.keyword} avgSteps=${(tally.steps / n).toFixed(1)} avgMs=${Math.round(tally.ms / n)}`
  );
}
