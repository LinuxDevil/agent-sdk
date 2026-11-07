/**
 * The `guardrail <name>` span every input, output and tool guardrail check
 * emits when the run is traced: a child of the `invoke_agent` span (or of
 * the tool call's `execute_tool` span), carrying the guardrail's name, kind
 * and outcome - never the checked text or the trip reason.
 */

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { mockModel } from '../testing';
import {
  checkOutputGuardrails,
  checkToolGuardrails,
  maxLengthGuardrail,
  regexGuardrail,
  type IoGuardrail,
} from './ioGuardrails';
import { secretsGuardrail } from './guardrailStarterSet';
import { GUARDRAIL_SPAN_NAME, GenAiAttr, GenAiOperation, SdkAttr } from './semconv';
import type { Span, TraceExporter } from './tracing';

/** An exporter that records every span it hears about, and a view of the ended guardrail ones. */
function recorder() {
  const started: Span[] = [];
  const ended: Span[] = [];
  const exporter: TraceExporter = { onSpanStart: (s) => void started.push(s), onSpanEnd: (s) => void ended.push(s) };
  const guardrailSpans = () => ended.filter((s) => s.name.startsWith(`${GUARDRAIL_SPAN_NAME} `));
  return { started, ended, exporter, guardrailSpans };
}

const agentSpan = (ended: Span[]) => ended.find((s) => s.name.startsWith(`${GenAiOperation.INVOKE_AGENT} `));

describe('guardrail check spans', () => {
  it('emits one span per check, a child of the invoke_agent span, outcome pass', async () => {
    const { ended, exporter, guardrailSpans } = recorder();
    const agent = createAgent({
      provider: mockModel(['all good']),
      guardrails: {
        input: [maxLengthGuardrail({ maxChars: 50 })],
        output: [secretsGuardrail({ name: 'secret-scan' })],
      },
      exporter,
    });

    const result = await agent.send('hi');

    expect(result.finishReason).toBe('stop');
    expect(guardrailSpans().map((s) => s.name)).toEqual(['guardrail max-length', 'guardrail secret-scan']);
    const run = agentSpan(ended);
    for (const span of guardrailSpans()) {
      expect(span.parentId).toBe(run?.id);
      expect(span.attributes[SdkAttr.GUARDRAIL_OUTCOME]).toBe('pass');
    }
    expect(guardrailSpans()[0].attributes).toMatchObject({
      [SdkAttr.GUARDRAIL_NAME]: 'max-length',
      [SdkAttr.GUARDRAIL_KIND]: 'input',
    });
    expect(guardrailSpans()[1].attributes).toMatchObject({
      [SdkAttr.GUARDRAIL_NAME]: 'secret-scan',
      [SdkAttr.GUARDRAIL_KIND]: 'output',
    });
  });

  it('a tripped input check ends its span with outcome block; the run still ends as before', async () => {
    const { exporter, guardrailSpans } = recorder();
    const model = mockModel(['never sent']);
    const agent = createAgent({
      provider: model,
      guardrails: { input: [maxLengthGuardrail({ maxChars: 5 })] },
      exporter,
    });

    const result = await agent.send('a much longer input than five characters');

    expect(model.calls).toHaveLength(0);
    expect(result.finishReason).toBe('guardrail');
    expect(result.guardrail?.name).toBe('max-length');
    const [span] = guardrailSpans();
    expect(span.name).toBe('guardrail max-length');
    expect(span.attributes[SdkAttr.GUARDRAIL_OUTCOME]).toBe('block');
    // A trip is an outcome, not a failure: no error status on the span.
    expect(span.status).toBeUndefined();
  });

  it('a rewriting check ends its span with outcome rewrite', async () => {
    const { exporter, guardrailSpans } = recorder();
    const model = mockModel(['ok']);
    const agent = createAgent({
      provider: model,
      guardrails: { input: [regexGuardrail({ name: 'ssn', pattern: /\d{3}-\d{2}-\d{4}/, action: 'rewrite' })] },
      exporter,
    });

    const result = await agent.send('ssn 123-45-6789');

    expect(result.finishReason).toBe('stop');
    expect(model.calls[0].messages.at(-1)?.content).toBe('ssn [redacted]');
    const [span] = guardrailSpans();
    expect(span.name).toBe('guardrail ssn');
    expect(span.attributes[SdkAttr.GUARDRAIL_OUTCOME]).toBe('rewrite');
  });

  it('a runInParallel input check gets lousho.guardrail.parallel: true', async () => {
    const { ended, exporter, guardrailSpans } = recorder();
    const parallel: IoGuardrail = { name: 'watch', runInParallel: true, check: () => ({ ok: true }) };
    const agent = createAgent({
      provider: mockModel(['hi']),
      guardrails: { input: [parallel] },
      exporter,
    });

    await agent.send('hello');

    const [span] = guardrailSpans();
    expect(span.name).toBe('guardrail watch');
    expect(span.parentId).toBe(agentSpan(ended)?.id);
    expect(span.attributes[SdkAttr.GUARDRAIL_KIND]).toBe('input');
    expect(span.attributes[SdkAttr.GUARDRAIL_PARALLEL]).toBe(true);
    expect(span.attributes[SdkAttr.GUARDRAIL_OUTCOME]).toBe('pass');
  });

  it('a tool guardrail span is a child of that tool call’s span and carries gen_ai.tool.name', async () => {
    const { ended, exporter, guardrailSpans } = recorder();
    const echo = defineTool({
      name: 'echo',
      description: 'Echoes a word',
      input: z.object({ word: z.string() }),
      execute: ({ word }) => word,
    });
    const agent = createAgent({
      provider: mockModel([{ toolCalls: [{ name: 'echo', args: { word: 'hi' } }] }, 'done']),
      tools: [echo],
      guardrails: { tools: [{ name: 'tool-check', check: () => ({ ok: true }) }] },
      exporter,
    });

    const result = await agent.send('go');

    expect(result.text).toBe('done');
    const toolSpan = ended.find((s) => s.name === `${GenAiOperation.EXECUTE_TOOL} echo`);
    const [span] = guardrailSpans();
    expect(span.name).toBe('guardrail tool-check');
    expect(span.parentId).toBe(toolSpan?.id);
    expect(span.attributes[GenAiAttr.TOOL_NAME]).toBe('echo');
    expect(span.attributes[SdkAttr.GUARDRAIL_KIND]).toBe('tool');
    expect(span.attributes[SdkAttr.GUARDRAIL_OUTCOME]).toBe('pass');
  });

  it('no span attribute holds the checked text or the trip reason', async () => {
    const { exporter, guardrailSpans } = recorder();
    const sentinel = 'SENTINEL-USER-INPUT-9f8e7d';
    const agent = createAgent({
      provider: mockModel(['never sent']),
      guardrails: { input: [maxLengthGuardrail({ maxChars: 5 })] },
      exporter,
    });

    await agent.send(`say ${sentinel} now`);

    const [span] = guardrailSpans();
    const attributes = JSON.stringify(span.attributes);
    expect(attributes).not.toContain(sentinel);
    expect(attributes).not.toContain('characters, over'); // the trip reason stays on the event, off the span
    // Ids and outcome only: name, kind, outcome.
    expect(Object.keys(span.attributes).sort()).toEqual(
      [SdkAttr.GUARDRAIL_KIND, SdkAttr.GUARDRAIL_NAME, SdkAttr.GUARDRAIL_OUTCOME].sort()
    );
  });
});

describe('without a span context the check runs directly', () => {
  it('no exporter: the check runs and the run is unchanged', async () => {
    const check = vi.fn(() => ({ ok: true }) as const);
    const agent = createAgent({
      provider: mockModel(['hi']),
      guardrails: { input: [{ name: 'g', check }] },
    });

    const result = await agent.send('hello');

    expect(result.finishReason).toBe('stop');
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('an exporter without a parent span emits nothing: the check is called directly', async () => {
    const { started, exporter } = recorder();
    const check = vi.fn(() => ({ ok: true }) as const);

    const args = await checkToolGuardrails(
      { guardrails: { tools: [{ name: 'g', check }] }, exporter },
      { toolName: 'some_tool', args: { a: 1 }, messages: [] }
    );

    expect(args).toEqual({ a: 1 });
    expect(check).toHaveBeenCalledTimes(1);
    expect(started).toHaveLength(0);
  });

  it('checkOutputGuardrails with a bare runtime returns the text untouched', async () => {
    const check = vi.fn(() => ({ ok: true }) as const);

    const checked = await checkOutputGuardrails({ guardrails: { output: [{ name: 'g', check }] } }, 'the reply', []);

    expect(checked).toEqual({ text: 'the reply', rewritten: false });
    expect(check).toHaveBeenCalledTimes(1);
  });
});
