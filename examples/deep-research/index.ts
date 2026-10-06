/**
 * deep-research - the "deep research" archetype Anthropic's multi-agent
 * research system uses: one lead coordinator that decomposes a question
 * into subtopics, fans them out to researcher sub-agents called in
 * parallel, then synthesizes their compressed, cited summaries into a
 * report with inline citations.
 *
 * `createDeepResearch()` builds it from two `createAgent()` calls:
 *
 *   1. a `researcher` sub-agent with one tool, `search`, that queries a
 *      small in-memory corpus - every `task` it gets runs in a clean
 *      context and comes back as a short cited summary
 *   2. a lead `coordinator` that issues several `task` calls in ONE model
 *      turn (same-turn tool calls run in parallel), then writes the
 *      report with inline [S#] citations and a source list
 *
 * Offline (the default) both run on scripted mock models, so the run is
 * deterministic, free and needs no network - the `search` calls still
 * execute for real against the corpus. With OPENROUTER_API_KEY set it
 * runs the same question for real on openrouter/openai/gpt-4o-mini.
 *
 * Run with: npx tsx examples/deep-research/index.ts ["question"]
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { createAgent, defineTool, textOf, toolResultText, type LLMProvider } from '../../src';
import { mockModel } from '../../src/testing';

export const LIVE_MODEL = 'openrouter/openai/gpt-4o-mini';
export const DEFAULT_QUESTION =
  'How do multi-agent deep research systems work, and when do they outperform a single agent?';
const DEFAULT_SUBTOPICS = [
  'orchestration architecture of multi-agent research systems',
  'parallelism and context isolation of sub-agents',
  'token cost and failure modes versus a single agent',
] as const;

/** A retrievable corpus entry; `id` is the citation marker the report uses inline. */
export interface ResearchSource {
  id: string;
  title: string;
  url: string;
  /** The passage a `search` call can return. */
  text: string;
  /** Extra terms that make the source findable. */
  keywords: string[];
}

export const CORPUS: ResearchSource[] = [
  {
    id: 'S1',
    title: 'Orchestrator-worker architectures for research agents',
    url: 'https://example.com/orchestrator-workers',
    text: 'A lead agent decomposes the query into subtopics and spawns parallel sub-agents, each working in its own context window. The sub-agents return compressed summaries and the lead synthesizes the final report.',
    keywords: ['orchestrator', 'lead', 'decompose', 'architecture', 'synthesize'],
  },
  {
    id: 'S2',
    title: 'Context isolation in multi-agent systems',
    url: 'https://example.com/context-isolation',
    text: 'Each sub-agent runs in a clean context: it sees only its task prompt and tool results, so it can read far more material than would fit in one shared transcript. Summaries, not raw passages, flow back to the orchestrator.',
    keywords: ['context', 'isolation', 'window', 'summaries', 'compression'],
  },
  {
    id: 'S3',
    title: 'Parallelism cuts research latency',
    url: 'https://example.com/parallel-research',
    text: 'Fanning out subtopics to parallel sub-agents turns a breadth-first question into bounded wall-clock time. Anthropic reports its multi-agent research system outperformed a single-agent setup by about 90 percent on an internal research evaluation.',
    keywords: ['parallel', 'latency', 'breadth', 'evaluation', 'faster', 'performance'],
  },
  {
    id: 'S4',
    title: 'Token economics of multi-agent research',
    url: 'https://example.com/token-economics',
    text: 'Multi-agent runs spend roughly 15x the tokens of a single chat turn, because every sub-agent keeps its own transcript and tool results. The pattern pays off on high-value breadth-first tasks and wastes money on narrow ones.',
    keywords: ['tokens', 'cost', 'budget', 'expensive', '15x'],
  },
  {
    id: 'S5',
    title: 'Failure modes of delegated research',
    url: 'https://example.com/failure-modes',
    text: 'Leads spawn more sub-agents than needed, sub-agents chase tangents, and summaries lose the provenance of individual claims. Explicit task boundaries and citation requirements limit the damage.',
    keywords: ['failure', 'modes', 'delegation', 'tangents', 'provenance', 'errors'],
  },
  {
    id: 'S6',
    title: 'Citations in generated research reports',
    url: 'https://example.com/citations',
    text: 'Every claim in the final report carries an inline citation to a source the sub-agents actually retrieved, and a source list maps each marker to a title and URL so a reader can verify it.',
    keywords: ['citations', 'sources', 'verify', 'claims', 'url'],
  },
  {
    id: 'S7',
    title: 'When a single agent is enough',
    url: 'https://example.com/single-agent',
    text: 'Sequential or narrow questions gain nothing from fan-out: one agent with tools is cheaper and at least as accurate. Multi-agent wins on queries whose subtopics can be researched independently.',
    keywords: ['single', 'narrow', 'sequential', 'baseline', 'cheaper'],
  },
  {
    id: 'S8',
    title: 'Evaluating deep-research systems',
    url: 'https://example.com/evaluating-research',
    text: 'Reports are scored on coverage, factual accuracy and citation quality. LLM-as-judge scales the grading, with sampled human review for calibration.',
    keywords: ['evaluation', 'judge', 'coverage', 'accuracy', 'metrics'],
  },
];

const STOPWORDS = new Set(
  'the a an and or of to in for on is are was how do does what when why this that with their its it be by at as from into than then they them we you your can each every only more not no research report subtopic deep question summarize find give'.split(' ')
);

function termsOf(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2 && !STOPWORDS.has(word));
}

/** Corpus sources matching `query`, best overlap first. */
export function rankSources(corpus: readonly ResearchSource[], query: string): ResearchSource[] {
  const terms = new Set(termsOf(query));
  return corpus
    .map((source) => {
      const haystack = new Set([...termsOf(source.title), ...termsOf(source.text), ...source.keywords.flatMap(termsOf)]);
      const score = [...terms].filter((term) => haystack.has(term)).length;
      return { source, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ source }) => source);
}

/** What the search tool did: call count and how overlapped the parallel calls were. */
export interface SearchStats {
  calls: number;
  /** Search calls in flight right now (internal bookkeeping). */
  inFlight: number;
  /** Highest `inFlight` reached - >= 2 proves the task fan-out ran in parallel. */
  maxConcurrent: number;
}

/** The researcher's only tool: keyword search over the in-memory corpus. */
export function createSearchTool(corpus: readonly ResearchSource[], stats?: SearchStats) {
  return defineTool({
    name: 'search',
    description:
      'Search the research corpus for passages on a topic. Returns the best-matching passages, each tagged with the [S#] source id to cite it by.',
    input: z.object({
      query: z.string().describe('Keywords or a short phrase to search for'),
      maxResults: z.number().int().min(1).max(5).optional().describe('Passages to return (default 3)'),
    }),
    async execute({ query, maxResults = 3 }) {
      if (stats) {
        stats.calls += 1;
        stats.inFlight += 1;
        stats.maxConcurrent = Math.max(stats.maxConcurrent, stats.inFlight);
        // Wait briefly for sibling tasks running in parallel to arrive, so
        // `maxConcurrent` records the real overlap; a sequential run just
        // pays the deadline per call.
        const deadline = Date.now() + 50;
        while (stats.inFlight < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 2));
      }
      try {
        const hits = rankSources(corpus, query).slice(0, maxResults);
        return hits.length
          ? hits.map((s) => `[${s.id}] ${s.title} (${s.url})\n${s.text}`).join('\n\n')
          : `No passages in the corpus match ${JSON.stringify(query)}.`;
      } finally {
        if (stats) stats.inFlight -= 1;
      }
    },
  });
}

const RESEARCHER_INSTRUCTIONS = [
  'You are a researcher sub-agent. The search tool queries a small corpus.',
  'Call search once with a focused query for the subtopic you are given.',
  'Then answer in at most five sentences, citing every fact with its [S#] marker.',
  'Report only what the corpus supports; say so when the search comes back empty.',
].join('\n');

const LEAD_INSTRUCTIONS = [
  'You coordinate a deep-research team.',
  'Decompose the question into 2-3 distinct subtopics and delegate each to the researcher sub-agent:',
  'one task call per subtopic, all in a single turn so they run in parallel.',
  'Each task returns a compressed summary carrying [S#] source markers.',
  'Then write the report: a one-paragraph answer up front, one short section per subtopic, every claim',
  'carrying its [S#] citation, and a "Sources" section mapping each cited [S#] to its title and URL.',
].join('\n');

export interface DeepResearchOptions {
  /** A `provider/model` string for live runs, e.g. `openrouter/openai/gpt-4o-mini`. */
  model?: string;
  /** The coordinator's provider offline / in tests; used instead of `model`. */
  provider?: LLMProvider;
  /** The researchers' provider offline; defaults to `provider`. */
  researcherProvider?: LLMProvider;
  /** The corpus `search` queries; defaults to {@link CORPUS}. */
  corpus?: ResearchSource[];
}

export function createDeepResearch(options: DeepResearchOptions = {}) {
  const { model = LIVE_MODEL, corpus = CORPUS } = options;
  const modelOptions = (provider?: LLMProvider) => (provider ? { provider } : { model });
  const stats: SearchStats = { calls: 0, inFlight: 0, maxConcurrent: 0 };

  const researcher = createAgent({
    name: 'researcher',
    description: 'Researches one subtopic with the search tool and returns a short summary with [S#] citations.',
    instructions: RESEARCHER_INSTRUCTIONS,
    ...modelOptions(options.researcherProvider ?? options.provider),
    tools: [createSearchTool(corpus, stats)],
    maxSteps: 6,
  });

  const agent = createAgent({
    name: 'coordinator',
    instructions: LEAD_INSTRUCTIONS,
    ...modelOptions(options.provider),
    subagents: { researcher },
    maxSteps: 10,
  });

  return { agent, stats };
}

/**
 * Compress a `search` result block into a cited summary: one line per
 * passage, keeping the title and the [S#] marker the report cites.
 */
export function summarizeSearchOutput(output: string): string {
  const blocks = output.split(/\n\n+/).filter((block) => /^\[S\d+\]/.test(block));
  if (blocks.length === 0) return `Nothing relevant found in the corpus (${output.slice(0, 120)}).`;
  return blocks
    .map((block) => {
      const [head = '', ...rest] = block.split('\n');
      const id = head.match(/^\[(S\d+)\]/)?.[1] ?? 'S?';
      const title = head.replace(/^\[S\d+\]\s*/, '').replace(/\s*\([^)]*\)\s*$/, '');
      const point = rest.join(' ').split(/(?<=[.!?])\s/)[0] ?? '';
      return `- ${title}: ${point.trim()} [${id}]`;
    })
    .join('\n');
}

/** The scripted researchers' model offline: each task does `search` -> cited summary, in any order. */
export function scriptedResearcher() {
  return mockModel(
    [
      (request) => {
        const last = request.messages.at(-1);
        if (last?.role === 'tool') return { text: summarizeSearchOutput(toolResultText(last)) };
        const prompt = request.messages
          .filter((m) => m.role === 'user')
          .map((m) => textOf(m))
          .at(-1);
        return { toolCalls: [{ name: 'search', args: { query: prompt ?? '' } }] };
      },
    ],
    { onExhausted: 'repeat-last' }
  );
}

/** Build the report text offline: the summaries the tasks returned, plus a source list. */
function scriptedReport(question: string, taskResults: readonly string[], corpus: readonly ResearchSource[]) {
  const body = taskResults
    .map((result, i) => `### Finding ${i + 1}\n${result.replace(/\n*\[sub-agent '[^\]]*\]\s*$/, '').trim()}`)
    .join('\n\n');
  const cited = [...new Set(taskResults.join(' ').match(/\[S\d+\]/g) ?? [])].map((marker) => marker.slice(1, -1));
  const sources = cited.map((id) => {
    const source = corpus.find((s) => s.id === id);
    return source ? `- [${id}] ${source.title} - ${source.url}` : `- [${id}] (not in corpus)`;
  });
  return [
    '# Deep research report',
    '',
    `Question: ${question}`,
    '',
    'The sub-agents researched the subtopics below in parallel; their compressed findings follow,',
    'each claim cited to the source it came from.',
    '',
    body,
    '',
    '## Sources',
    ...(sources.length ? sources : ['- (no sources cited)']),
  ].join('\n');
}

/** The scripted coordinator offline: fan out one `task` per subtopic in a single turn, then report. */
export function scriptedLead(subtopics: readonly string[] = DEFAULT_SUBTOPICS, corpus: readonly ResearchSource[] = CORPUS) {
  return mockModel([
    {
      toolCalls: subtopics.map((subtopic) => ({
        name: 'task',
        args: {
          agent: 'researcher',
          prompt: `Research this subtopic for a deep-research report, then summarize with [S#] citations: ${subtopic}`,
          description: `Research: ${subtopic}`.slice(0, 48),
        },
      })),
    },
    (request) => {
      const question = request.messages.find((m) => m.role === 'user');
      const results = request.messages.filter((m) => m.role === 'tool').map((m) => toolResultText(m));
      return { text: scriptedReport(question ? textOf(question) : DEFAULT_QUESTION, results, corpus) };
    },
  ]);
}

export async function main(question = DEFAULT_QUESTION) {
  const live = Boolean(process.env.OPENROUTER_API_KEY);
  const { agent, stats } = createDeepResearch(
    live ? {} : { provider: scriptedLead(), researcherProvider: scriptedResearcher() }
  );

  console.log(live ? `Live run on ${LIVE_MODEL}` : 'Offline run with scripted models');
  console.log(`Question: ${question}\n`);
  const result = await agent.send(question);

  console.log(result.text);
  console.log(
    `\nfinish reason: ${result.finishReason}, steps: ${result.steps}, ` +
      `searches: ${stats.calls} (max concurrent ${stats.maxConcurrent}), cost: ${result.usage?.costUsd ?? 'n/a'} USD`
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  main(process.argv.slice(2).join(' ') || undefined).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
