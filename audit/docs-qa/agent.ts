/**
 * The docs Q&A agent: one `search_docs` tool over the docs index and a
 * structured `{ answer, citations: [{ file, heading }] }` output.
 */
import { z } from 'zod';
import { createAgent, defineTool, type LLMProvider } from '@lousho/build-ai-agent';
import { localProvider } from '../_shared/local.js';
import type { Hit, Retriever } from './retriever.js';

export const AnswerSchema = z.object({
  answer: z.string().describe('The answer, in a few sentences, using only the search results.'),
  citations: z
    .array(
      z.object({
        file: z.string().describe('The `file` field of a search result, e.g. docs/evals.md'),
        heading: z.string().describe('The `heading` field of that search result'),
      })
    )
    .describe('The search results the answer is based on. At least one.'),
});
export type Answer = z.infer<typeof AnswerSchema>;

export const PROMPT = [
  'You answer questions about the Lousho TypeScript agent SDK using its documentation.',
  'Always call search_docs first (call it at most twice; one well-phrased query is usually enough).',
  'Answer ONLY from the search results. If they do not contain the answer, say so.',
  'Cite every result you used: copy its `file` and `heading` fields exactly.',
].join('\n');

export interface DocsAgentOptions {
  retriever: Retriever;
  provider?: LLMProvider;
  k?: number;
  maxSteps?: number;
}

/** Builds the agent plus a log of every hit the tool returned (for citation checks). */
export function buildDocsAgent({ retriever, provider, k = 3, maxSteps = 6 }: DocsAgentOptions) {
  const retrieved: Hit[] = [];
  const searchDocs = defineTool({
    name: 'search_docs',
    description: 'Semantic search over the Lousho SDK docs. Returns the most relevant sections with file and heading.',
    input: z.object({ query: z.string().min(2).describe('What to look for, in natural language') }),
    async execute({ query }) {
      const hits = await retriever.search(query, k);
      retrieved.push(...hits);
      return hits.map((h) => ({ file: h.file, heading: h.section, score: h.score, excerpt: h.text.slice(0, 700) }));
    },
  });
  const agent = createAgent({
    name: 'docs-qa',
    provider: provider ?? localProvider(),
    prompt: PROMPT,
    tools: [searchDocs],
    output: AnswerSchema,
    maxSteps,
    // createAgent() has no maxTokens/temperature: cap them per call with a hook (8k ctx on LM Studio; a reasoning model can think past it).
    hooks: [{ name: 'limits', preGenerate(ctx) { ctx.request.maxTokens ??= Number(process.env.DOCSQA_MAX_TOKENS ?? 3000); ctx.request.temperature ??= 0.2; } }],
  });
  return { agent, retrieved };
}

export interface CitationCheck {
  valid: number;
  invalid: Array<{ file: string; heading: string; why: string }>;
  grounded: boolean;
}

/** Citation enforcement the app has to do itself: every citation must point at a section the tool returned. */
export function checkCitations(answer: Answer | undefined, retrieved: readonly Hit[]): CitationCheck {
  const invalid: CitationCheck['invalid'] = [];
  let valid = 0;
  for (const c of answer?.citations ?? []) {
    const file = c.file.replace(/\\/g, '/').replace(/^\.?\//, '');
    const sameFile = retrieved.filter((h) => h.file === file || h.file.endsWith(`/${file}`));
    if (sameFile.length === 0) invalid.push({ ...c, why: 'file never returned by search_docs' });
    else if (!sameFile.some((h) => h.section.toLowerCase() === c.heading.toLowerCase().replace(/^#+\s*/, '')))
      invalid.push({ ...c, why: 'heading not among returned sections of that file' });
    else valid++;
  }
  return { valid, invalid, grounded: valid > 0 && invalid.length === 0 };
}
