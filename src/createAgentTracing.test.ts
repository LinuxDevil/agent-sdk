/**
 * CreateAgent({ exporter, captureContent }) traces every kind of run:
 * send(), stream(), agent.approvals.resolve() and agent.resume().
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Tracer } from '@opentelemetry/api';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createAgent } from './createAgent';
import { PropagatingToolError } from './execution/AgentExecutor';
import { createOtelTraceExporter } from './execution/otel';
import { observeExporterFromEnv } from './observe/reporter';
import { fileTraceExporter } from './traces/fileTraceExporter';
import type { TraceLine } from './traces/format';
import { withSpan, type Span, type TraceExporter } from './execution/tracing';
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

describe('createAgent({ exporter })', () => {
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

  it('send({ parentSpanId }) parents the invoke_agent span to the caller span', async () => {
    const exporter = recording();
    const agent = createAgent({ provider: mockModel(['One.', 'Two.']), exporter });
    await withSpan(exporter, 'pipeline', {}, async (span) => {
      await agent.send('first', { parentSpanId: span.id });
      await agent.send('second', { parentSpanId: span.id });
    });

    const pipeline = exporter.ended.find((span) => span.name === 'pipeline')!;
    const runs = exporter.ended.filter((span) => op(span) === 'invoke_agent');
    expect(runs).toHaveLength(2);
    expect(runs.map((span) => span.parentId)).toEqual([pipeline.id, pipeline.id]);
  });

  it('stream({ parentSpanId }) parents the invoke_agent span to the caller span', async () => {
    const exporter = recording();
    const run = createAgent({ provider: mockModel(['Hi.']), exporter }).stream('Hello', { parentSpanId: 'caller-span' });
    for await (const event of run) void event;

    expect(exporter.ended.find((span) => op(span) === 'invoke_agent')!.parentId).toBe('caller-span');
  });

  it('send() without parentSpanId starts a root invoke_agent span', async () => {
    const exporter = recording();
    await createAgent({ provider: mockModel(['Hi.']), exporter }).send('Hello');

    expect(exporter.ended.find((span) => op(span) === 'invoke_agent')!.parentId).toBeUndefined();
  });

  describe('agent.approvals.resolve() (#281)', () => {
    const sendEmail = defineTool({
      name: 'send_email',
      description: 'Sends an email',
      input: z.object({ to: z.string() }),
      needsApproval: true,
      execute: async ({ to }) => `sent to ${to}`,
    });
    const emailAgent = (options: Omit<Parameters<typeof createAgent>[0], 'provider' | 'tools'>) =>
      createAgent({
        provider: mockModel([{ toolCalls: [{ name: 'send_email', args: { to: 'sam@example.com' }, id: 'call_1' }] }, 'Sent.']),
        tools: [sendEmail],
        ...options,
      });

    it('traces the continued run, with the approved tool as an execute_tool span under its invoke_agent span', async () => {
      const exporter = recording();
      const agent = emailAgent({ exporter, redactContent: false });
      const paused = await agent.send('Email Sam');
      const before = exporter.ended.length;

      await agent.approvals.resolve({ id: paused.approvalId!, approved: true });

      const spans = exporter.ended.slice(before);
      expect(ops(spans)).toEqual(['chat', 'execute_tool', 'invoke_agent']);
      const run = spans.find((span) => op(span) === 'invoke_agent')!;
      const tool = spans.find((span) => op(span) === 'execute_tool')!;
      expect(tool.name).toBe('execute_tool send_email');
      expect(tool.parentId).toBe(run.id);
      expect(tool.attributes['gen_ai.tool.call.id']).toBe('call_1');
      expect(tool.attributes['gen_ai.tool.name']).toBe('send_email');
      expect(tool.attributes['result']).toBe('sent to sam@example.com');
      expect(tool.attributes['gen_ai.tool.call.arguments']).toBeUndefined();
      expect(run.parentId).toBeUndefined();
      // the tool ran before the continued model call
      expect(tool.startTime).toBeLessThanOrEqual(spans.find((span) => op(span) === 'chat')!.startTime);
    });

    it('records the call arguments and result with captureContent', async () => {
      const captured = recording();
      const first = emailAgent({ exporter: captured, captureContent: true });
      const paused = await first.send('Email Sam');
      await first.approvals.resolve({ id: paused.approvalId!, approved: true });
      const tool = captured.ended.filter((span) => op(span) === 'execute_tool').at(-1)!;
      expect(tool.attributes['gen_ai.tool.call.arguments']).toContain('sam@example.com');
      expect(tool.attributes['gen_ai.tool.call.result']).toContain('sent to sam@example.com');

    });

    it('marks a tool that failed after approval as an error span, and a rejection runs no tool', async () => {
      const exporter = recording();
      const broken = defineTool({
        name: 'send_email',
        description: 'Sends an email',
        input: z.object({ to: z.string() }),
        needsApproval: true,
        execute: async () => {
          throw new Error('smtp down');
        },
      });
      const agent = createAgent({
        provider: mockModel([{ toolCalls: [{ name: 'send_email', args: { to: 'a@b.c' } }] }, 'Failed.']),
        tools: [broken],
        exporter,
      });
      const paused = await agent.send('Email');
      await agent.approvals.resolve({ id: paused.approvalId!, approved: true });
      const tool = exporter.ended.filter((span) => op(span) === 'execute_tool').at(-1)!;
      expect(tool.status?.code).toBe('error');

      const rejecting = recording();
      const other = emailAgent({ exporter: rejecting });
      const second = await other.send('Email Sam');
      const sent = rejecting.ended.length;
      await other.approvals.resolve({ id: second.approvalId!, approved: false });
      expect(ops(rejecting.ended.slice(sent))).toEqual(['chat', 'invoke_agent']);
    });

    it('reaches fileTraceExporter() in the trace of the continued run', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-traces-'));
      try {
        const agent = emailAgent({ exporter: fileTraceExporter({ dir }) });
        const paused = await agent.send('Email Sam');
        await agent.approvals.resolve({ id: paused.approvalId!, approved: true });

        const lines = fs
          .readdirSync(dir)
          .flatMap((day) => fs.readdirSync(path.join(dir, day)).map((name) => fs.readFileSync(path.join(dir, day, name), 'utf8')))
          .flatMap((text) => text.trim().split('\n').map((line) => JSON.parse(line) as TraceLine));
        const tool = lines.find((line) => line.name === 'execute_tool send_email')!;
        const parent = lines.find((line) => line.id === tool.parentId)!;
        expect(parent.name).toMatch(/^invoke_agent /);
        expect(tool.traceId).toBe(parent.traceId);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('reaches an OpenTelemetry exporter, started after the continued run span and before its model call', async () => {
      const started: string[] = [];
      const tracer = {
        startSpan: (name: string) => {
          started.push(name);
          return { setAttribute() {}, setStatus() {}, end() {} };
        },
        startActiveSpan: () => undefined,
      } as unknown as Tracer;
      const agent = emailAgent({ exporter: createOtelTraceExporter({ tracer, metrics: false }) });
      const paused = await agent.send('Email Sam');
      started.length = 0;

      await agent.approvals.resolve({ id: paused.approvalId!, approved: true });

      expect(started.map((name) => name.split(' ')[0])).toEqual(['invoke_agent', 'execute_tool', 'chat']);
    });
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

  it('invoke_agent gen_ai.input.messages parses as JSON once - a Message[] input is not double-encoded', async () => {
    const exporter = recording();
    await createAgent({ provider: mockModel(['Hi.']), exporter, captureContent: true }).send('Hello');

    const run = exporter.ended.find((span) => op(span) === 'invoke_agent')!;
    // createAgent always hands the executor a Message[]; one JSON.parse must
    // yield the message parts, with `content` the literal text (not a second
    // JSON document).
    expect(JSON.parse(run.attributes['gen_ai.input.messages'] as string)).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'Hello' }] },
    ]);
  });

  describe('redactContent', () => {
    const lookup = defineTool({
      name: 'lookup',
      description: 'Looks something up',
      input: z.object({ q: z.string() }),
      execute: async ({ q }) => `result for ${q}`,
    });
    const agent = (options: Omit<Parameters<typeof createAgent>[0], 'provider' | 'tools'>) =>
      createAgent({
        provider: mockModel([{ toolCalls: [{ name: 'lookup', args: { q: 'private-query' }, id: 'call_1' }] }, 'Done.']),
        tools: [lookup],
        ...options,
      });
    const attributeValues = (span: Span) => Object.values(span.attributes).map((value) => JSON.stringify(value));

    it('keeps prompt and tool IO off the spans when set on createAgent', async () => {
      const exporter = recording();
      await agent({ exporter, redactContent: true }).send('the prompt');

      const run = exporter.ended.find((span) => op(span) === 'invoke_agent')!;
      const chat = exporter.ended.filter((span) => op(span) === 'chat');
      const tool = exporter.ended.find((span) => op(span) === 'execute_tool')!;
      expect(chat).toHaveLength(2);
      for (const span of [run, ...chat, tool]) {
        expect(span.attributes).not.toHaveProperty('input');
        expect(span.attributes).not.toHaveProperty('prompt');
        expect(span.attributes).not.toHaveProperty('args');
        expect(span.attributes).not.toHaveProperty('result');
        for (const value of attributeValues(span)) {
          expect(value).not.toContain('the prompt');
          expect(value).not.toContain('private-query');
          expect(value).not.toContain('result for private-query');
        }
      }
      // Non-content fields are never redacted.
      expect(tool.attributes['gen_ai.tool.name']).toBe('lookup');
      expect(chat[0].attributes['gen_ai.response.finish_reasons']).toBeDefined();
    });

    const traceFileText = (dir: string) =>
      fs
        .readdirSync(dir)
        .flatMap((day) => fs.readdirSync(path.join(dir, day)).map((name) => fs.readFileSync(path.join(dir, day, name), 'utf8')))
        .join('');

    it('keeps prompt and tool IO out of the .lousho/traces files by default', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-traces-'));
      try {
        await agent({ exporter: fileTraceExporter({ dir }), instructions: 'system-secret' }).send('the prompt');

        const text = traceFileText(dir);
        expect(text.length).toBeGreaterThan(0);
        for (const secret of ['the prompt', 'system-secret', 'private-query', 'result for private-query']) {
          expect(text).not.toContain(secret);
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('records the deprecated content attributes only when redactContent is false', async () => {
      const exporter = recording();
      await agent({ exporter, redactContent: false }).send('the prompt');

      const run = exporter.ended.find((span) => op(span) === 'invoke_agent')!;
      const tool = exporter.ended.find((span) => op(span) === 'execute_tool')!;
      expect(JSON.stringify(run.attributes.input)).toContain('the prompt');
      expect(tool.attributes.args).toEqual({ q: 'private-query' });
      expect(tool.attributes.result).toBe('result for private-query');
    });

    it('keeps prompt and tool IO out of the .lousho/traces files', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-traces-'));
      try {
        await agent({ exporter: fileTraceExporter({ dir }), redactContent: true }).send('the prompt');

        const lines = fs
          .readdirSync(dir)
          .flatMap((day) => fs.readdirSync(path.join(dir, day)).map((name) => fs.readFileSync(path.join(dir, day, name), 'utf8')))
          .flatMap((text) => text.trim().split('\n').map((line) => JSON.parse(line) as TraceLine));
        expect(lines.length).toBeGreaterThan(0);
        for (const line of lines) {
          const attributes = JSON.stringify(line.attributes);
          expect(attributes).not.toContain('the prompt');
          expect(attributes).not.toContain('private-query');
          expect(attributes).not.toContain('result for private-query');
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

describe('captureContent default on a local collector', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  /** The ingest bodies the env reporter POSTed; each test gets a fresh reporter through a unique agent name. */
  let posted: string[] = [];
  let names = 0;
  const observe = (value: string) => {
    posted = [];
    vi.stubEnv('LOUSHO_OBSERVE', value);
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      posted.push(String(init.body));
      return new Response('{}', { status: 200 });
    });
  };
  const daemonText = async (name: string) => {
    await observeExporterFromEnv({ agentName: name })?.flush();
    return posted.join('');
  };
  const chatInput = async (options: { captureContent?: boolean; redactContent?: boolean } = {}) => {
    const exporter = recording();
    const name = `content-default-${++names}`;
    await createAgent({ name, provider: mockModel(['Hi.']), exporter, ...options }).send('my key is sk-secret123');
    return { chat: exporter.ended.find((span) => op(span) === 'chat')!, daemon: await daemonText(name) };
  };

  it('captures content for the loopback daemon only, never for the config exporter', async () => {
    observe('1');
    const { chat, daemon } = await chatInput();
    expect(chat.attributes['gen_ai.input.messages']).toBeUndefined();
    expect(chat.attributes['gen_ai.output.messages']).toBeUndefined();
    expect(chat.attributes['gen_ai.request.model']).toBeDefined();
    expect(daemon).toContain('my key is');
    expect(daemon).toContain('Hi.');
  });

  it('keeps content out of fileTraceExporter() files while the loopback daemon gets it', async () => {
    observe('1');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-traces-'));
    try {
      const name = `content-default-${++names}`;
      await createAgent({ name, provider: mockModel(['Hi.']), exporter: fileTraceExporter({ dir }) }).send('my key is sk-secret123');
      const files = fs
        .readdirSync(dir)
        .flatMap((day) => fs.readdirSync(path.join(dir, day)).map((file) => fs.readFileSync(path.join(dir, day, file), 'utf8')))
        .join('');
      expect(files.length).toBeGreaterThan(0);
      expect(files).not.toContain('sk-secret123');
      expect(await daemonText(name)).toContain('sk-secret123');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('captureContent: true still reaches every exporter', async () => {
    observe('1');
    const { chat, daemon } = await chatInput({ captureContent: true });
    expect(chat.attributes['gen_ai.input.messages']).toContain('my key is');
    expect(daemon).toContain('my key is');
  });

  it('the OTel content env var still reaches every exporter', async () => {
    observe('1');
    vi.stubEnv('OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT', 'true');
    expect((await chatInput()).chat.attributes['gen_ai.input.messages']).toContain('my key is');
  });

  it('does not capture by default for a non-loopback collector', async () => {
    observe('http://collector.test:7777');
    const { chat, daemon } = await chatInput();
    expect(chat.attributes['gen_ai.input.messages']).toBeUndefined();
    expect(daemon).not.toContain('my key is');
  });

  it('does not capture by default when LOUSHO_OBSERVE is unset', async () => {
    vi.stubEnv('LOUSHO_OBSERVE', '');
    const exporter = recording();
    await createAgent({ provider: mockModel(['Hi.']), exporter }).send('my key is sk-secret123');
    expect(exporter.ended.find((span) => op(span) === 'chat')!.attributes['gen_ai.input.messages']).toBeUndefined();
  });

  it('captureContent: false wins over the loopback default', async () => {
    observe('1');
    const { chat, daemon } = await chatInput({ captureContent: false });
    expect(chat.attributes['gen_ai.input.messages']).toBeUndefined();
    expect(daemon).not.toContain('my key is');
  });

  it('redactContent: false records the deprecated prompt next to the loopback-captured content', async () => {
    observe('1');
    const { chat, daemon } = await chatInput({ redactContent: false });
    expect(chat.attributes.prompt).toBeDefined();
    expect(daemon).toContain('my key is');
  });

  it('redactContent: true keeps the deprecated prompt off while the daemon still gets gen_ai content', async () => {
    observe('1');
    const { chat, daemon } = await chatInput({ redactContent: true });
    expect(chat.attributes.prompt).toBeUndefined();
    expect(daemon).toContain('my key is');
  });

  it('resume() captures content for the loopback daemon by default', async () => {
    observe('1');
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
    const name = `content-default-${++names}`;
    const crashing = createAgent({ name, provider: mockModel([{ toolCalls: [{ name: 'flaky', id: 'c1' }] }]), tools: [flaky], store });
    await expect(crashing.send('Go', { sessionId: 'job' })).rejects.toThrow('process died');
    const exporter = recording();
    await createAgent({ name, provider: mockModel(['Done.']), tools: [flaky], store, exporter }).resume('job');
    expect(exporter.ended.find((span) => op(span) === 'chat')!.attributes['gen_ai.output.messages']).toBeUndefined();
    expect(await daemonText(name)).toContain('Done.');
  });
});
