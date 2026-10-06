import { describe, it, expect } from 'vitest';
import { toolResultText } from '../../src';
import { testToolContext } from '../../src/testing';
import {
  CORPUS,
  createDeepResearch,
  createSearchTool,
  scriptedLead,
  scriptedResearcher,
  summarizeSearchOutput,
} from './index';

const SUBTOPICS = ['multi-agent orchestration architecture', 'token cost versus a single agent'];

describe('examples/deep-research', () => {
  it('fans out parallel researcher tasks in one turn and writes a cited report', async () => {
    const lead = scriptedLead(SUBTOPICS);
    const researcher = scriptedResearcher();
    const { agent, stats } = createDeepResearch({ provider: lead, researcherProvider: researcher });

    const result = await agent.send('How do multi-agent research systems work?');

    expect(result.finishReason).toBe('stop');

    // Fan-out: the lead issued every `task` call in one model turn, so the
    // next request already carries all their results at once.
    const secondCall = lead.calls[1];
    const taskResults = secondCall.messages.filter((m) => m.role === 'tool').map((m) => toolResultText(m));
    expect(taskResults.length).toBeGreaterThanOrEqual(2);
    expect(taskResults.join('\n')).toContain('taskId');

    // The sub-agent runs really overlapped, and really queried the corpus.
    expect(stats.maxConcurrent).toBeGreaterThanOrEqual(2);
    expect(stats.calls).toBe(SUBTOPICS.length);
    // Each task took two model calls: one that searched, one that summarized.
    expect(researcher.calls).toHaveLength(SUBTOPICS.length * 2);

    // A cited report came back, with markers that resolve to corpus sources.
    expect(result.text).toMatch(/\[S\d+\]/);
    expect(result.text).toContain('## Sources');
    lead.assertExhausted();
  });

  it('search ranks corpus passages and tags them with [S#] ids', async () => {
    const search = createSearchTool(CORPUS);

    const hits = await search.execute({ query: 'token cost budget' }, testToolContext());
    expect(hits).toContain('[S4]');

    const none = await search.execute({ query: 'quantum baking recipes' }, testToolContext());
    expect(none).toContain('No passages');
  });

  it('compresses search output into a cited summary', () => {
    const output = ['[S3] Parallelism cuts research latency (https://x.test)\nIt is fast. Details follow.', '', '[S9] Other (https://y.test)\nUnrelated.'].join(
      '\n\n'
    );
    const summary = summarizeSearchOutput(output);
    expect(summary).toContain('Parallelism cuts research latency');
    expect(summary).toContain('[S3]');
    expect(summary).not.toContain('https://x.test');
    expect(summary).toContain('It is fast.');
  });
});
