/**
 * M5a: createAgent({ exporter, captureContent }) traces every kind of run:
 * send(), stream(), agent.approvals.resolve() and agent.resume().
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAgent } from './createAgent';
import { PropagatingToolError } from './execution/AgentExecutor';
import type { Span, TraceExporter } from './execution/tracing';
import { memoryStore } from './storage/agentStore';
import { mockModel } from './testing';
import { defineTool } from './tools/defineTool';

/** An exporter that keeps the spans it was told about. */
function recording(): TraceExporter & { ended: Span[] } {
  const ended: Span[] = [];
  return { ended, onSpanStart: () => {}, onSpanEnd: (span) => ended.push({ ...span }) };
}

const op = (span: Span) => span.attributes['gen_ai.operation.name'];
const ops = (spans: Span[]) => spans.map(op).sort();

describe('createAgent({ exporter }) (M5a)', () => {
  it('send() produces invoke_agent and chat spans', async () => {
    const exporter = recording();
    await createAgent({ name: 'a', provider: mockModel(['Hi.']), exporter }).send('Hello');

    expect(ops(exporter.ended)).toEqual(['chat', 'invoke_agent']);
    expect(exporter.ended.find((span) => op(span) === 'invoke_agent')!.name).toBe('invoke_agent a');
  });

  it('stream() produces spans', async () => {
    const exporter = recording();
    const run = createAgent({ provider: mockModel(['Hi.']), exporter }).stream('Hello');
    for await (const event of run) void event;

    expect(ops(exporter.ended)).toEqual(['chat', 'invoke_agent']);
  });

  // The approved tool itself runs in resume.ts before the continued run starts, outside any span.
  it('agent.approvals.resolve() traces the continued run', async () => {
    const exporter = recording();
    const sendEmail = defineTool({
      name: 'send_email',
      description: 'Sends an email',
      input: z.object({ to: z.string() }),
      needsApproval: true,
      execute: async ({ to }) => `sent to ${to}`,
    });
    const agent = createAgent({
      provider: mockModel([{ toolCalls: [{ name: 'send_email', args: { to: 'sam@example.com' } }] }, 'Sent.']),
      tools: [sendEmail],
      exporter,
    });
    const paused = await agent.send('Email Sam');
    const before = exporter.ended.length;

    await agent.approvals.resolve({ id: paused.approvalId!, approved: true });

    expect(ops(exporter.ended.slice(before))).toEqual(['chat', 'invoke_agent']);
  });

  it('agent.resume() traces the finished run', async () => {
    const exporter = recording();
    const store = memoryStore();
    let crashed = false;
    const flaky = defineTool({
      name: 'flaky',
      description: 'Dies once',
      input: z.object({}),
      execute: async () => {
        if (!crashed) {
          crashed = true;
          throw new PropagatingToolError('process died');
        }
        return 'ok';
      },
    });
    const crashing = createAgent({ provider: mockModel([{ toolCalls: [{ name: 'flaky', id: 'c1' }] }]), tools: [flaky], store });
    await expect(crashing.send('Go', { sessionId: 'job' })).rejects.toThrow('process died');

    const agent = createAgent({ provider: mockModel(['Done.']), tools: [flaky], store, exporter });
    const result = await agent.resume('job');

    expect(result?.text).toBe('Done.');
    expect(ops(exporter.ended)).toEqual(expect.arrayContaining(['invoke_agent', 'chat', 'execute_tool']));
  });

  it('captureContent records message content on the spans', async () => {
    const exporter = recording();
    await createAgent({ provider: mockModel(['Hi.']), exporter, captureContent: true }).send('Hello');

    const chat = exporter.ended.find((span) => op(span) === 'chat')!;
    expect(chat.attributes['gen_ai.input.messages']).toContain('Hello');
    expect(chat.attributes['gen_ai.output.messages']).toContain('Hi.');
  });
});
