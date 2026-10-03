import { describe, expect, it } from 'vitest';
import { memoryStore } from '../storage/agentStore';
import { ALICE, fakeOAuthServer, githubProvider, listReposTool } from '../oauth/__fixtures__/fakeOAuth';
import { z } from 'zod';
import { readUIMessageStream, type UIMessage, type UIMessageChunk } from 'ai-v7';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { mockModel } from '../testing';
import { createTodoTools } from '../tools/built-in/todo';
import {
  fromUIMessages,
  toUIMessageStream,
  toUIMessageStreamResponse,
  type LoushoUIMessageChunk,
  type UIMessageLike,
} from './uiMessageStream';

const weather = defineTool({
  name: 'get_weather',
  description: 'Weather',
  input: z.object({ city: z.string() }),
  execute: ({ city }) => ({ city, temp: 18 }),
});

async function collect<T>(stream: ReadableStream<T>): Promise<T[]> {
  const items: T[] = [];
  const reader = stream.getReader();
  for (let r = await reader.read(); !r.done; r = await reader.read()) items.push(r.value);
  return items;
}

const toolRun = () =>
  createAgent({
    provider: mockModel([
      { text: 'Checking.', toolCalls: [{ name: 'get_weather', args: { city: 'Paris' }, id: 'call_1' }], usage: { inputTokens: 3, outputTokens: 2 } },
      'It is 18C.',
    ]),
    tools: [weather],
  }).stream('Weather in Paris?');

describe('toUIMessageStream (LOU-P1)', () => {
  it('maps text, a tool call and a second step to ordered chunks', async () => {
    const chunks = await collect(toUIMessageStream(toolRun()));
    const summary = chunks.map((c) => c.type).filter((type, i, all) => type !== 'text-delta' || all[i - 1] !== 'text-delta');
    const deltas = chunks.flatMap((c) => (c.type === 'text-delta' ? [c.delta] : []));
    expect(deltas.join('')).toBe('Checking.It is 18C.');
    expect(summary).toEqual([
      'start',
      'start-step',
      'text-start',
      'text-delta',
      'text-end',
      'tool-input-start',
      'tool-input-available',
      'tool-output-available',
      'finish-step',
      'start-step',
      'text-start',
      'text-delta',
      'text-end',
      'finish-step',
      'finish',
    ]);
    expect(chunks.find((c) => c.type === 'tool-input-available')).toMatchObject({ toolCallId: 'call_1', toolName: 'get_weather', input: { city: 'Paris' } });
    expect(chunks.find((c) => c.type === 'tool-output-available')).toMatchObject({ output: { city: 'Paris', temp: 18 } });
    const finish = chunks.at(-1);
    expect(finish).toMatchObject({ type: 'finish', finishReason: 'stop', messageMetadata: { loushoFinishReason: 'stop', usage: { totalTokens: expect.any(Number) } } });
  });

  it('maps a failing tool and a failed run to error chunks', async () => {
    const boom = defineTool({ name: 'boom', description: 'Fails', input: z.object({}), execute: () => { throw new Error('kaput'); } });
    const toolErr = createAgent({ provider: mockModel([{ toolCalls: [{ name: 'boom', id: 'c' }] }, 'ok']), tools: [boom] }).stream('go');
    expect((await collect(toUIMessageStream(toolErr))).find((c) => c.type === 'tool-output-error')).toMatchObject({ toolCallId: 'c', errorText: expect.stringContaining('kaput') });

    const failed = createAgent({ provider: mockModel([{ error: new Error('model down') }]) }).stream('hi');
    const chunks = await collect(toUIMessageStream(failed));
    expect(chunks.find((c) => c.type === 'error')).toMatchObject({ errorText: expect.stringContaining('model down') });
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', finishReason: 'error' });
  });

  it('emits an approval pause as a data-lousho-approval part', async () => {
    const deploy = defineTool({ name: 'deploy', description: 'Deploys', input: z.object({ env: z.string() }), needsApproval: true, execute: () => 'done' });
    const run = createAgent({ provider: mockModel([{ toolCalls: [{ name: 'deploy', args: { env: 'prod' }, id: 'c1' }] }]), tools: [deploy] }).stream('deploy');
    const chunks = await collect(toUIMessageStream(run));
    const approval = chunks.find((c) => c.type === 'data-lousho-approval');
    expect(approval).toMatchObject({ data: { toolCallId: 'c1', toolName: 'deploy', input: { env: 'prod' } } });
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', finishReason: 'other', messageMetadata: { loushoFinishReason: 'awaiting-approval' } });
  });

  it('emits a sign-in pause with its link in the data-lousho-approval part (N9b)', async () => {
    const github = githubProvider(fakeOAuthServer());
    const { tool } = listReposTool(github);
    const agent = createAgent({ provider: mockModel([{ toolCalls: [{ name: 'list_repos', id: 'c1' }] }]), tools: [tool], store: memoryStore() });
    const chunks = await collect(toUIMessageStream(agent.stream('list', { principal: ALICE })));
    const approval = chunks.find((c) => c.type === 'data-lousho-approval');
    expect(approval).toMatchObject({ data: { toolName: 'list_repos', kind: 'sign-in', signIn: { provider: 'github', displayName: 'GitHub', url: expect.stringContaining('code_challenge_method=S256') } } });
  });

  it('emits a todo.updated event as a data-lousho-todos part (N12)', async () => {
    const write = { name: 'todo_write', args: { todos: [{ content: 'a', status: 'in_progress' }, { content: 'b', status: 'pending' }] } };
    const run = createAgent({ provider: mockModel([{ toolCalls: [write] }, 'ok']), tools: createTodoTools().tools }).stream('go');
    const chunks = await collect(toUIMessageStream(run));
    expect(chunks.filter((c) => c.type === 'data-lousho-todos')).toEqual([
      {
        type: 'data-lousho-todos',
        id: 'todos',
        data: {
          todos: [
            { id: 'todo_1', content: 'a', status: 'in_progress' },
            { id: 'todo_2', content: 'b', status: 'pending' },
          ],
          counts: { pending: 1, in_progress: 1, completed: 0, total: 2 },
        },
      },
    ]);
  });

  it('N13b: a generator tool streams preliminary tool-output-available chunks, then the final one', async () => {
    const counter = defineTool({
      name: 'count_to',
      description: 'Counts',
      input: z.object({ n: z.number() }),
      async *execute({ n }) {
        for (let i = 1; i <= n; i++) yield { at: i };
      },
    });
    const run = () => createAgent({ provider: mockModel([{ toolCalls: [{ name: 'count_to', args: { n: 2 }, id: 'c1' }] }, 'Done.']), tools: [counter] }).stream('count');

    const outputs = (await collect(toUIMessageStream(run()))).filter((c) => c.type === 'tool-output-available');
    expect(outputs).toEqual([
      { type: 'tool-output-available', toolCallId: 'c1', output: { at: 1 }, preliminary: true },
      { type: 'tool-output-available', toolCallId: 'c1', output: { at: 2 }, preliminary: true },
      { type: 'tool-output-available', toolCallId: 'c1', output: { at: 2 } },
    ]);

    // The real ai v7 reader shows each snapshot as a preliminary output, and ends on the final one.
    const stream = toUIMessageStream(run()) as ReadableStream<LoushoUIMessageChunk> as unknown as ReadableStream<UIMessageChunk>;
    const seen: unknown[] = [];
    for await (const message of readUIMessageStream({ stream })) {
      const part = message.parts.find((p) => p.type === 'tool-count_to') as { state?: string; output?: unknown; preliminary?: boolean } | undefined;
      if (part?.state === 'output-available') seen.push({ output: part.output, preliminary: part.preliminary ?? false });
    }
    expect(seen.at(0)).toEqual({ output: { at: 1 }, preliminary: true });
    expect(seen.at(-1)).toEqual({ output: { at: 2 }, preliminary: false });
  });

  it('is read by the real ai v7 UI message stream reader into a message with text and tool parts', async () => {
    const stream = toUIMessageStream(toolRun()) as ReadableStream<LoushoUIMessageChunk> as unknown as ReadableStream<UIMessageChunk>;
    let last: UIMessage | undefined;
    for await (const message of readUIMessageStream({ stream })) last = message;
    expect(last?.role).toBe('assistant');
    const text = last?.parts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text);
    expect(text).toEqual(['Checking.', 'It is 18C.']);
    const tool = last?.parts.find((p) => p.type === 'tool-get_weather');
    expect(tool).toMatchObject({ toolCallId: 'call_1', state: 'output-available', input: { city: 'Paris' }, output: { city: 'Paris', temp: 18 } });
    expect(last?.parts.some((p) => p.type === 'step-start')).toBe(true);
  });
});

describe('toUIMessageStreamResponse (LOU-P1)', () => {
  it('frames chunks as SSE, ends with [DONE] and sets the protocol header', async () => {
    const response = toUIMessageStreamResponse(toolRun(), { status: 201, headers: { 'x-extra': '1' } });
    expect(response.status).toBe(201);
    expect(response.headers.get('x-vercel-ai-ui-message-stream')).toBe('v1');
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(response.headers.get('x-extra')).toBe('1');
    const body = await response.text();
    const frames = body.split('\n\n').filter(Boolean);
    expect(frames.at(-1)).toBe('data: [DONE]');
    const parsed = frames.slice(0, -1).map((frame) => JSON.parse(frame.replace(/^data: /, '')) as LoushoUIMessageChunk);
    expect(parsed[0].type).toBe('start');
    expect(parsed.at(-1)?.type).toBe('finish');
  });
});

describe('fromUIMessages (LOU-P1)', () => {
  const messages: UIMessageLike[] = [
    { role: 'user', parts: [{ type: 'text', text: 'Hi' }] },
    { role: 'assistant', parts: [{ type: 'step-start' }, { type: 'text', text: 'Hello!' }, { type: 'tool-get_weather' }] },
    {
      role: 'user',
      parts: [
        { type: 'text', text: 'What is this?' },
        { type: 'file', mediaType: 'image/png', url: 'data:image/png;base64,AAAA' },
        { type: 'file', mediaType: 'application/pdf', url: 'https://x.test/a.pdf', filename: 'a.pdf' },
        { type: 'reasoning', text: 'ignored' },
      ],
    },
  ];

  it('converts every message, ignoring unknown parts and dropping empty messages', () => {
    expect(fromUIMessages([...messages, { role: 'assistant', parts: [{ type: 'data-x' }] }])).toEqual([
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello!' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is this?' },
          { type: 'image', image: 'data:image/png;base64,AAAA', mimeType: 'image/png' },
          { type: 'file', data: 'https://x.test/a.pdf', mimeType: 'application/pdf', filename: 'a.pdf' },
        ],
      },
    ]);
  });

  it('returns only the last user message as the input with lastUserOnly', () => {
    expect(fromUIMessages(messages.slice(0, 2), { lastUserOnly: true })).toBe('Hi');
    expect(fromUIMessages(messages, { lastUserOnly: true })).toHaveLength(3);
    expect(fromUIMessages([], { lastUserOnly: true })).toBe('');
  });
});
