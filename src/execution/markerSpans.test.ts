/**
 * Marker spans: a handoff and a pause for approval each leave a
 * zero-length span in the run's trace, parented to the run's
 * `invoke_agent` span, so a trace consumer can mark the handoff target as
 * the active node and a tool node as waiting.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { mockModel } from '../testing';
import type { Span, TraceExporter } from './tracing';
import { APPROVAL_WAIT_SPAN_NAME, GenAiAttr, HANDOFF_SPAN_NAME, SdkAttr } from './semconv';

function recorder() {
  const started: Span[] = [];
  const ended: Span[] = [];
  const exporter: TraceExporter = { onSpanStart: (s) => void started.push(s), onSpanEnd: (s) => void ended.push(s) };
  return { started, ended, exporter };
}

const named = (spans: Span[], prefix: string) => spans.filter((s) => s.name.startsWith(`${prefix} `));

const callEmail = (id = 'call_email') => ({ toolCalls: [{ name: 'send_email', args: { to: 'sam@example.com' }, id }] });

function emailTool() {
  const execute = vi.fn(async ({ to }: { to: string }) => `sent to ${to}`);
  const tool = defineTool({
    name: 'send_email',
    description: 'Sends an email',
    input: z.object({ to: z.string() }),
    needsApproval: true,
    execute,
  });
  return { tool, execute };
}

afterEach(() => { vi.restoreAllMocks(); });

describe('handoff marker span', () => {
  it('a handed-off run exports one zero-length `handoff <to>` span under the run span', async () => {
    const { started, ended, exporter } = recorder();
    const billing = createAgent({
      name: 'billing',
      description: 'Answers billing questions',
      provider: mockModel(['Your refund is on its way.']),
    });
    const triage = createAgent({
      name: 'triage',
      provider: mockModel([{ toolCalls: [{ name: 'transfer_to_billing', args: { reason: 'charged twice' }, id: 'call_handoff' }] }]),
      handoffs: [billing],
      exporter,
    });

    const result = await triage.send('I was charged twice');

    expect(result.agentName).toBe('billing');
    const run = started.find((s) => s.name === 'invoke_agent triage');
    const handoffs = named(started, HANDOFF_SPAN_NAME);
    expect(handoffs).toHaveLength(1);
    const marker = handoffs[0];
    expect(marker.name).toBe('handoff billing');
    expect(marker.attributes[SdkAttr.HANDOFF_FROM]).toBe('triage');
    expect(marker.attributes[SdkAttr.HANDOFF_TO]).toBe('billing');
    expect(marker.attributes[GenAiAttr.TOOL_CALL_ID]).toBe('call_handoff');
    expect(marker.parentId).toBe(run?.id);
    expect(marker.startTime).toBe(marker.endTime);
    // It is notified like any span.
    expect(ended).toContain(marker);
  });
});

describe('approval.wait marker span', () => {
  it('a paused run exports one `approval.wait <tool>` span per paused call, carrying the approval id', async () => {
    const { started, exporter } = recorder();
    const { tool, execute } = emailTool();
    const agent = createAgent({ provider: mockModel([callEmail()]), tools: [tool], exporter });

    const paused = await agent.send('Email Sam');

    expect(paused.finishReason).toBe('awaiting-approval');
    expect(execute).not.toHaveBeenCalled();
    const run = started.find((s) => s.name.startsWith('invoke_agent'));
    const waits = named(started, APPROVAL_WAIT_SPAN_NAME);
    expect(waits).toHaveLength(1);
    const wait = waits[0];
    expect(wait.name).toBe('approval.wait send_email');
    expect(wait.attributes[SdkAttr.APPROVAL_ID]).toBe(paused.approvalId);
    expect(wait.attributes[SdkAttr.APPROVAL_KIND]).toBe('tool');
    expect(wait.attributes[GenAiAttr.TOOL_NAME]).toBe('send_email');
    expect(wait.attributes[GenAiAttr.TOOL_CALL_ID]).toBe('call_email');
    expect(wait.parentId).toBe(run?.id);
    expect(wait.startTime).toBe(wait.endTime);
  });

  it('emits one span per call of a step paused on several', async () => {
    const { started, exporter } = recorder();
    const { tool } = emailTool();
    const agent = createAgent({
      provider: mockModel([
        {
          toolCalls: [
            { name: 'send_email', args: { to: 'a@x.test' }, id: 'call_1' },
            { name: 'send_email', args: { to: 'b@x.test' }, id: 'call_2' },
          ],
        },
      ]),
      tools: [tool],
      exporter,
    });

    const paused = await agent.send('Email both');

    expect(paused.approvalIds).toHaveLength(2);
    const waits = named(started, APPROVAL_WAIT_SPAN_NAME);
    expect(waits).toHaveLength(2);
    expect(waits.map((s) => s.attributes[SdkAttr.APPROVAL_ID]).sort()).toEqual([...paused.approvalIds!].sort());
    expect(waits.map((s) => s.attributes[GenAiAttr.TOOL_CALL_ID]).sort()).toEqual(['call_1', 'call_2']);
  });

  it('resuming a paused run and pausing again emits a new `approval.wait` span under the resumed run span', async () => {
    const { started, exporter } = recorder();
    const { tool } = emailTool();
    const agent = createAgent({ provider: mockModel([callEmail('call_1'), callEmail('call_2'), 'Done.']), tools: [tool], exporter });

    const first = await agent.send('Email Sam twice');
    const second = await agent.approvals.resolve({ id: first.approvalId!, approved: true });

    expect(second.finishReason).toBe('awaiting-approval');
    const runs = started.filter((s) => s.name.startsWith('invoke_agent'));
    const waits = named(started, APPROVAL_WAIT_SPAN_NAME);
    expect(runs).toHaveLength(2);
    expect(waits).toHaveLength(2);
    expect(waits[0].parentId).toBe(runs[0].id);
    // The second pause happened inside the resume's `invoke_agent` span.
    expect(waits[1].parentId).toBe(runs[1].id);
    expect(waits[1].attributes[SdkAttr.APPROVAL_ID]).toBe(second.approvalId);
  });
});

describe('exporter failures', () => {
  it('a throwing exporter does not fail the run', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const exporter: TraceExporter = {
      onSpanStart() {
        throw new Error('span start boom');
      },
      onSpanEnd() {
        throw new Error('span end boom');
      },
    };
    const billing = createAgent({ name: 'billing', description: 'Bills', provider: mockModel(['done']) });
    const triage = createAgent({
      name: 'triage',
      provider: mockModel([{ toolCalls: [{ name: 'transfer_to_billing', args: {}, id: 'call_handoff' }] }]),
      handoffs: [billing],
      exporter,
    });

    const result = await triage.send('go');
    expect(result.agentName).toBe('billing');
    expect(result.finishReason).toBe('stop');

    const { tool } = emailTool();
    const pausing = createAgent({ provider: mockModel([callEmail()]), tools: [tool], exporter });
    const paused = await pausing.send('Email Sam');
    expect(paused.finishReason).toBe('awaiting-approval');
  });
});
