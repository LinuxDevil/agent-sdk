import { describe, it, expect } from 'vitest';
import { createAgent } from '../createAgent';
import { mockModel } from '../testing';
import type { Span } from '../execution/tracing';

function recordingExporter() {
  const spans: Span[] = [];
  return { spans, exporter: { onSpanStart() {}, onSpanEnd: (span: Span) => void spans.push(span) } };
}

const task = (agent: string) => ({ name: 'task', args: { agent, prompt: 'p', description: agent } });

describe('sub-agent invoke_agent spans (Eve MA-F10)', () => {
  it('names an unnamed sub-agent by its key and records its name, depth and taskId', async () => {
    const { spans, exporter } = recordingExporter();
    const researcher = createAgent({ provider: mockModel(['r']), instructions: 'You research.', description: 'Finds sources' });
    const writer = createAgent({ name: 'pen', provider: mockModel(['w']), instructions: 'You write.', description: 'Writes' });
    const lead = createAgent({
      provider: mockModel([{ toolCalls: [task('researcher'), task('writer')] }, 'done']),
      instructions: 'You coordinate.',
      subagents: { researcher, writer },
      exporter,
    });

    const result = await lead.send('go');

    const runs = spans.filter((span) => span.name.startsWith('invoke_agent'));
    expect(runs.map((span) => span.name).sort()).toEqual(['invoke_agent agent', 'invoke_agent pen', 'invoke_agent researcher']);
    const researcherSpan = runs.find((span) => span.name === 'invoke_agent researcher')!;
    expect(researcherSpan.attributes).toMatchObject({
      'gen_ai.agent.name': 'researcher',
      'lousho.subagent.name': 'researcher',
      'lousho.subagent.depth': 1,
    });
    const taskIds = result.messages.flatMap((m) => (typeof m.content === 'string' ? [...m.content.matchAll(/taskId '([^']+)'/g)].map((x) => x[1]) : []));
    expect(taskIds).toContain(researcherSpan.attributes['lousho.task.id']);
    // A named sub-agent keeps its own name; the key is still recorded.
    expect(runs.find((span) => span.name === 'invoke_agent pen')!.attributes).toMatchObject({
      'gen_ai.agent.name': 'pen',
      'lousho.subagent.name': 'writer',
    });
    // The top-level run is not a sub-agent.
    expect(runs.find((span) => span.name === 'invoke_agent agent')!.attributes['lousho.subagent.name']).toBeUndefined();
  });

  it('records the depth of a nested sub-agent', async () => {
    const { spans, exporter } = recordingExporter();
    const leaf = createAgent({ provider: mockModel(['leaf done']), instructions: 'leaf', description: 'Leaf' });
    const middle = createAgent({
      provider: mockModel([{ toolCalls: [task('leaf')] }, 'middle done']),
      instructions: 'middle',
      description: 'Middle',
      subagents: { leaf },
    });
    const lead = createAgent({
      provider: mockModel([{ toolCalls: [task('middle')] }, 'done']),
      instructions: 'lead',
      subagents: { middle },
      maxSubagentDepth: 2,
      exporter,
    });

    await lead.send('go');

    const depthOf = (name: string) => spans.find((span) => span.name === `invoke_agent ${name}`)?.attributes['lousho.subagent.depth'];
    expect(depthOf('middle')).toBe(1);
    expect(depthOf('leaf')).toBe(2);
  });
});
