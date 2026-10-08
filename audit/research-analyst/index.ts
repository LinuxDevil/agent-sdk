/**
 * research-analyst — a deep-research pipeline on the packed SDK.
 *
 * Real-world flow: a question comes in → a coordinator decomposes it and
 * fans slices out to a `researcher` sub-agent with parallel `task` calls
 * (clean-context isolation: each task sees only its prompt) → a verifier
 * agent judges the aggregate with a structured `{ pass, gaps[] }` verdict →
 * gaps seed one bounded extension wave → a writer agent assembles a
 * structured report ({title, sections[], citations[], confidence}) → usage
 * and cost are reconciled across every run → spans land in a JSONL trace
 * dir → an llmJudge scores the report.
 *
 * Run from audit/:  npx tsx research-analyst/index.ts
 * Needs OPENROUTER_API_KEY (loaded by _shared/env).
 */
import '../_shared/env.js';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  createAgent,
  defineTool,
  estimateCost,
  formatUsage,
  llmJudge,
  resolveProvider,
  toolResultText,
  withSpan,
  type ExecutionResult,
  type RunUsage,
} from '@lousho/build-ai-agent';
import { fileTraceExporter, listTraces, readTrace } from '@lousho/build-ai-agent/traces';
import { hasLiveKey, LIVE_MODEL, report } from '../_shared/env.js';
import { CORPUS, searchCorpus, searchStats, servedIds } from './corpus.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const traceDir = path.join(here, 'traces');
rmSync(traceDir, { recursive: true, force: true }); // clean slate: trace counts reflect THIS run only
mkdirSync(traceDir, { recursive: true });
const exporter = fileTraceExporter({ dir: traceDir });

const QUESTION =
  process.argv.slice(2).join(' ') ||
  'What breaks first when a Node.js app is under memory pressure?';
const MAX_WAVES = 2;
/** Canary planted only in the coordinator's instructions; it must never leak into a sub-agent's brief. */
const CANARY = 'ZEBRA-7717';
/** The judge sees this id form ('openai/gpt-4o-mini'), not the 'openrouter/' spec. */
const MODEL_ID = LIVE_MODEL.split('/').slice(1).join('/');

// ---------------------------------------------------------------- schemas

const VERDICT = z.object({
  pass: z.boolean().describe('true only when the aggregate covers every required area'),
  gaps: z.array(z.string()).describe('Concrete topics a follow-up wave must still cover; empty when pass'),
});

const REPORT = z.object({
  title: z.string(),
  sections: z.array(z.object({ heading: z.string(), body: z.string() })).min(2),
  citations: z.array(
    z.object({
      id: z.string().describe('Corpus citation id, e.g. C3'),
      title: z.string(),
      url: z.string(),
    })
  ),
  confidence: z.number().min(0).max(1),
});
type Report = z.infer<typeof REPORT>;

// ---------------------------------------------------------------- tools

const knowledgeSearch = defineTool({
  name: 'knowledge_search',
  description:
    'Search a curated corpus of Node.js memory-internals notes. Returns matching entries with citation ids (C1..C8), title, url and text.',
  input: z.object({ query: z.string().describe('Keywords describing what to look up') }),
  execute: async ({ query }) => {
    searchStats.calls++;
    searchStats.inFlight++;
    searchStats.maxConcurrent = Math.max(searchStats.maxConcurrent, searchStats.inFlight);
    try {
      const hits = searchCorpus(query);
      for (const hit of hits) servedIds.add(hit.id);
      return { query, hits: hits.map(({ id, title, url, text }) => ({ id, title, url, text })) };
    } finally {
      searchStats.inFlight--;
    }
  },
});

// ---------------------------------------------------------------- agents

const researcher = createAgent({
  name: 'researcher',
  description:
    'Researches one slice of a Node.js internals question using the knowledge_search corpus; returns a compact cited brief.',
  instructions:
    'You are a Node.js internals researcher. You get one self-contained research slice. ' +
    'ALWAYS call knowledge_search at least once before answering (use 1-2 queries). ' +
    'Answer with 3-6 tight findings; every finding must end with the [C#] id(s) of the corpus entries that support it. ' +
    'Cite only ids the tool actually returned. No preamble, no caveats.',
  model: LIVE_MODEL,
  tools: [knowledgeSearch],
  maxSteps: 4,
});

const coordinator = createAgent({
  name: 'coordinator',
  instructions:
    `You are a research coordinator. You never answer domain questions yourself. ` +
    `Decompose the user's research question into the requested slices and delegate each to the 'researcher' sub-agent ` +
    `with the task tool. IMPORTANT: issue ALL task calls in a SINGLE response so they run in parallel — never spread ` +
    `them over multiple turns. After the results arrive, answer with one line per slice: its label and whether it came back. ` +
    `Internal tracking token (never repeat it): ${CANARY}.`,
  model: LIVE_MODEL,
  subagents: { researcher },
  maxSteps: 6,
  exporter,
});

const verifier = createAgent({
  name: 'verifier',
  instructions:
    'You are a strict coverage verifier for research aggregates. Judge whether the aggregate answers the question across ' +
    'ALL of: (1) V8 heap limits and GC behavior, (2) event-loop impact, (3) external/native memory and RSS, ' +
    '(4) OS/container OOM kills, (5) diagnostics (heap snapshots, tooling), (6) mitigations/backpressure. ' +
    'pass=true only if every area has real substance. Otherwise pass=false and list each missing/weak area as a concrete gap.',
  model: LIVE_MODEL,
  output: VERDICT,
  exporter,
});

const writer = createAgent({
  name: 'writer',
  instructions:
    'You assemble research reports as structured JSON. Use ONLY the supplied research briefs. ' +
    'citations[] must only use C# ids that appear in the briefs; copy title/url from the supplied citation catalog. ' +
    'confidence reflects how well the briefs answer the question.',
  model: LIVE_MODEL,
  output: REPORT,
  exporter,
});

// ---------------------------------------------------------------- helpers

interface RunRecord {
  label: string;
  ms: number;
  usage: RunUsage;
  steps: number;
  /** `stepUsage.length` — this process's own model calls (should exclude delegated children). */
  ownModelCalls: number;
  finishReason: string;
  taskCalls: number;
}
const ledger: RunRecord[] = [];

interface TaskSlice {
  args: { agent: string; prompt: string; description?: string };
  result: string;
  sameTurn: boolean;
}

/** Task calls + their results, pulled out of a coordinator run's transcript. */
function slicesOf(result: ExecutionResult): TaskSlice[] {
  const argsByCallId = new Map<string, TaskSlice['args']>();
  const taskCallsPerMessage: number[] = [];
  for (const message of result.messages) {
    const taskCalls = (message.toolCalls ?? []).filter((c) => c.function.name === 'task');
    if (taskCalls.length) taskCallsPerMessage.push(taskCalls.length);
    for (const call of taskCalls) {
      try {
        argsByCallId.set(call.id, JSON.parse(call.function.arguments));
      } catch {
        argsByCallId.set(call.id, { agent: '?', prompt: '<unparseable args>' });
      }
    }
  }
  const multi = Math.max(0, ...taskCallsPerMessage) >= 2;
  return result.messages
    .filter((m) => m.role === 'tool' && m.toolName === 'task')
    .map((m) => ({
      args: argsByCallId.get(m.toolCallId ?? '') ?? { agent: '?', prompt: '?' },
      result: toolResultText(m),
      sameTurn: multi,
    }));
}

function countTaskCalls(result: ExecutionResult): number {
  return result.toolCalls.filter((c) => c.function.name === 'task').length;
}

async function timed<TObject>(label: string, run: () => Promise<ExecutionResult<TObject>>): Promise<ExecutionResult<TObject>> {
  const started = Date.now();
  const result = await run();
  ledger.push({
    label,
    ms: Date.now() - started,
    usage: result.usage,
    steps: result.steps,
    ownModelCalls: result.stepUsage?.length ?? 0,
    finishReason: result.finishReason,
    taskCalls: countTaskCalls(result),
  });
  return result;
}

/** True when two spans overlap in wall time (parallelism proof from the trace file). */
function overlaps(
  a: { startTime: number; endTime?: number },
  b: { startTime: number; endTime?: number }
): boolean {
  const aEnd = a.endTime ?? a.startTime;
  const bEnd = b.endTime ?? b.startTime;
  return a.startTime < bEnd && b.startTime < aEnd;
}

// ---------------------------------------------------------------- pipeline

async function main(): Promise<void> {
  if (!hasLiveKey) {
    report('env', false, 'OPENROUTER_API_KEY missing — cannot run live');
    process.exitCode = 1;
    return;
  }
  console.log(`question: ${QUESTION}`);
  console.log(`model: ${LIVE_MODEL}  ·  maxWaves: ${MAX_WAVES}  ·  traces: ${traceDir}`);

  const allSlices: TaskSlice[] = [];
  const seen = new Set<string>();
  let wavesRun = 0;
  let verdict = { pass: false, gaps: [] as string[] };

  // ---- wave loop: coordinator fans out, verifier judges, gaps extend ----
  for (let wave = 1; wave <= MAX_WAVES; wave++) {
    wavesRun = wave;
    const prompt =
      wave === 1
        ? `Research question: "${QUESTION}"\n\n` +
          `Decompose it into exactly 3 independent slices (e.g. V8 heap/GC behavior; event-loop impact; ` +
          `external/native memory and process-level OOM) and delegate each to the researcher — ` +
          `all 3 task calls in ONE response.`
        : `The research on "${QUESTION}" is missing coverage of:\n` +
          verdict.gaps.map((g, i) => `  ${i + 1}. ${g}`).join('\n') +
          `\nDelegate each gap to the researcher — all ${verdict.gaps.length} task calls in ONE response.`;

    const waveResult = await withSpan(
      exporter,
      `research.wave.${wave}`,
      { wave, prompts: prompt.length },
      () => timed(`wave-${wave}-coordinator`, () => coordinator.send(prompt))
    );

    if (waveResult.finishReason !== 'stop') {
      report(`wave ${wave} coordinator`, false, `finishReason=${waveResult.finishReason} text=${waveResult.text.slice(0, 160)}`);
    }
    const slices = slicesOf(waveResult);
    for (const slice of slices) {
      if (!seen.has(slice.args.prompt)) {
        seen.add(slice.args.prompt);
        allSlices.push(slice);
      }
    }
    console.log(`\n--- wave ${wave}: ${slices.length} task result(s), sameTurn=${slices.every((s) => s.sameTurn)} ---`);
    for (const s of slices) console.log(`  [${s.args.description ?? s.args.agent}] ${s.args.prompt.slice(0, 90)}`);

    // ---- verify ----
    const aggregate = allSlices.map((s, i) => `### Brief ${i + 1}\n${s.result}`).join('\n\n');
    const checked = await timed(`wave-${wave}-verifier`, () =>
      verifier.send(`Question: "${QUESTION}"\n\nAggregate research:\n${aggregate}\n\nJudge coverage.`)
    );
    verdict = checked.object ?? { pass: false, gaps: ['<verifier produced no parseable verdict>'] };
    if (!checked.object) {
      report('verifier structured output', false, `finishReason=${checked.finishReason} outputError=${JSON.stringify(checked.outputError)?.slice(0, 200)}`);
    }
    console.log(`verdict: pass=${verdict.pass} gaps=${JSON.stringify(verdict.gaps)}`);
    if (verdict.pass || verdict.gaps.length === 0) break;
  }

  const aggregate = allSlices.map((s, i) => `### Brief ${i + 1}\n${s.result}`).join('\n\n');
  const catalog = CORPUS.map((c) => `${c.id}: ${c.title} <${c.url}>`).join('\n');

  // ---- structured report ----
  const written = await withSpan(exporter, 'research.report', { briefs: allSlices.length }, () =>
    timed('report-writer', () =>
      writer.send(
        `Question: "${QUESTION}"\n\nResearch briefs:\n${aggregate}\n\nCitation catalog:\n${catalog}\n\nWrite the report.`
      )
    )
  );
  const reportObject: Report | undefined = written.object;

  // ---- evals stretch: llmJudge on the report ----
  let judgeScore: number | undefined;
  let judgeError: string | undefined;
  try {
    const scorer = llmJudge({
      provider: resolveProvider(LIVE_MODEL),
      model: MODEL_ID,
      rubric:
        'The report answers "what breaks first when a Node.js app is under memory pressure" accurately, ' +
        'orders early symptoms before terminal failure, and carries citations. 1.0 = excellent.',
      allowOutsideJudgeRunner: true,
    });
    judgeScore = await scorer(written);
  } catch (error) {
    judgeError = (error as Error).message;
  }

  // ---- trace read-back ----
  const traces = await listTraces({ dir: traceDir, limit: 50 });
  let parallelProof = { files: 0, coordinatorSpans: 0, childInvokeSpans: 0, overlappingPairs: 0 };
  for (const t of traces) {
    const spans = await readTrace(t.traceId, { dir: traceDir });
    const children = spans.filter(
      (s) => s.name === `invoke_agent researcher` && typeof s.parentId === 'string'
    );
    if (children.length >= 2) {
      parallelProof.coordinatorSpans++;
      parallelProof.childInvokeSpans += children.length;
      for (let i = 0; i < children.length; i++)
        for (let j = i + 1; j < children.length; j++) if (overlaps(children[i], children[j])) parallelProof.overlappingPairs++;
    }
  }
  parallelProof.files = traces.length;

  // ================================================================ report
  console.log('\n================ AUDIT RESULTS ================');

  // 1. fan-out
  const taskCalls = ledger.filter((r) => r.label.includes('coordinator')).reduce((n, r) => n + r.taskCalls, 0);
  const sameTurn = allSlices.length > 0 && allSlices.every((s) => s.sameTurn);
  report(
    'waves/sub-agent fan-out',
    taskCalls >= 3 && sameTurn && allSlices.length >= 3,
    `${taskCalls} task call(s) over ${wavesRun} wave(s); ${allSlices.length} briefs; all issued same-turn=${sameTurn}`
  );
  report(
    'parallel execution (trace overlap)',
    parallelProof.overlappingPairs > 0 || searchStats.maxConcurrent > 1,
    `overlapping researcher span pairs=${parallelProof.overlappingPairs}; knowledge_search maxConcurrent=${searchStats.maxConcurrent}`
  );
  const canaryLeaked = allSlices.some((s) => s.result.includes(CANARY));
  report('clean-context isolation', !canaryLeaked, `coordinator canary ${canaryLeaked ? 'LEAKED into' : 'absent from'} sub-agent briefs`);

  // 2. verify + extend
  report(
    'verify + extend',
    verdict.pass !== undefined && (verdict.pass || wavesRun > 1 || verdict.gaps.length === 0),
    `waves=${wavesRun}/${MAX_WAVES} final pass=${verdict.pass} gaps=${verdict.gaps.length}`
  );

  // 3. structured output
  const citationsValid =
    reportObject !== undefined &&
    reportObject.citations.length > 0 &&
    reportObject.citations.every((c) => CORPUS.some((e) => e.id === c.id));
  const citationsServed =
    reportObject !== undefined && reportObject.citations.every((c) => servedIds.has(c.id));
  report(
    'structured output report',
    reportObject !== undefined && reportObject.sections.length >= 2,
    reportObject
      ? `title=${JSON.stringify(reportObject.title)} sections=${reportObject.sections.length} citations=${reportObject.citations.length} confidence=${reportObject.confidence} allIdsInCorpus=${citationsValid} allIdsServed=${citationsServed}`
      : `object missing; finishReason=${written.finishReason} outputError=${JSON.stringify(written.outputError)?.slice(0, 200)}`
  );

  // 4. usage + cost accounting
  const sum = ledger.reduce(
    (a, r) => ({
      input: a.input + r.usage.inputTokens,
      output: a.output + r.usage.outputTokens,
      total: a.total + r.usage.totalTokens,
      calls: a.calls + r.usage.modelCalls,
      cost: a.cost + (r.usage.costUsd ?? 0),
    }),
    { input: 0, output: 0, total: 0, calls: 0, cost: 0 }
  );
  const priced = ledger.every((r) => typeof r.usage.costUsd === 'number');
  console.log('\nper-run usage:');
  for (const r of ledger) {
    const d = r.usage.delegated;
    console.log(
      `  ${r.label.padEnd(22)} ${formatUsage(r.usage).padEnd(52)} ` +
        `steps=${r.steps} finish=${r.finishReason}${d ? ` delegated{runs=${d.runs},calls=${d.modelCalls},in=${d.inputTokens},out=${d.outputTokens},cost=$${d.costUsd?.toFixed(4)}}` : ''}`
    );
  }
  // invariants: byModel sums to totals; delegated.runs == task calls; stepUsage counts only own calls
  let invariants = '';
  let invariantOk = true;
  for (const r of ledger) {
    const by = Object.values(r.usage.byModel).reduce((a, m) => a + m.inputTokens + m.outputTokens, 0);
    if (by !== r.usage.inputTokens + r.usage.outputTokens) {
      invariantOk = false;
      invariants += ` ${r.label}:byModel!=totals`;
    }
    if (r.usage.delegated && r.usage.delegated.runs !== r.taskCalls) {
      invariantOk = false;
      invariants += ` ${r.label}:delegated.runs(${r.usage.delegated.runs})!=taskCalls(${r.taskCalls})`;
    }
    if (r.ownModelCalls + (r.usage.delegated?.modelCalls ?? 0) !== r.usage.modelCalls) {
      invariantOk = false;
      invariants += ` ${r.label}:stepUsage(${r.ownModelCalls})+delegated(${r.usage.delegated?.modelCalls ?? 0})!=modelCalls(${r.usage.modelCalls})`;
    }
  }
  const manualCost = estimateCost({ inputTokens: sum.input, outputTokens: sum.output }, MODEL_ID);
  const costMatch =
    manualCost !== undefined && Math.abs(manualCost - sum.cost) < 1e-9;
  report(
    'usage + cost accounting',
    priced && invariantOk && costMatch,
    `total ${sum.input}in/${sum.output}out across ${sum.calls} model calls; ` +
      `sum(costUsd)=$${sum.cost.toFixed(6)} vs estimateCost=$${manualCost?.toFixed(6) ?? 'unknown'}; byModel sums match=${invariantOk}${invariants}`
  );

  // 5. observability
  report(
    'observability (fileTraceExporter + withSpan)',
    parallelProof.files >= ledger.length && parallelProof.childInvokeSpans >= 2,
    `${parallelProof.files} trace file(s); ${parallelProof.childInvokeSpans} nested invoke_agent researcher spans across coordinator traces; withSpan phase spans emitted`
  );

  // 6. evals
  report(
    'llmJudge eval (stretch)',
    judgeScore !== undefined,
    judgeScore !== undefined ? `score=${judgeScore}` : `error: ${judgeError}`
  );

  // ---- final report artifact ----
  console.log('\n================ FINAL REPORT ================');
  if (reportObject) {
    console.log(`# ${reportObject.title}   (confidence ${reportObject.confidence})`);
    for (const s of reportObject.sections) console.log(`\n## ${s.heading}\n${s.body}`);
    console.log(`\nCitations: ${reportObject.citations.map((c) => `[${c.id}] ${c.title}`).join('; ')}`);
    writeFileSync(path.join(here, 'report.json'), JSON.stringify({ question: QUESTION, verdict, report: reportObject, usage: ledger }, null, 2));
  } else {
    console.log('(no structured report)');
  }
  console.log(`\nwall: ${ledger.reduce((a, r) => a + r.ms, 0)}ms across ${ledger.length} runs; traces in ${traceDir}`);
}

main().catch((error) => {
  console.error('pipeline failed:', error);
  report('pipeline', false, (error as Error).message);
  process.exitCode = 1;
});
