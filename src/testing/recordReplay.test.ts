import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';
import { CassetteMismatchError, mockModel, recordReplay, setProviderInterceptor } from './index';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { CompactedLLMProviderError, SDKError } from '../execution/errors';
import type { GenerateOptions, StreamChunk } from '../providers/llm';
import { textOf } from '../providers';
import { resolveProvider } from '../providers/resolveProvider';

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cassette-'));
  file = path.join(dir, 'nested', 'flow.json');
});

afterEach(() => {
  setProviderInterceptor(undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

const ask = (content: string, extra: Partial<GenerateOptions> = {}): GenerateOptions => ({
  messages: [{ role: 'user', content }],
  ...extra,
});

const forbidden = (): never => {
  throw new Error('the wrapped provider must not be constructed in replay mode');
};

const readJson = (): { entries: Array<{ request: { messages: Array<{ content: string }> } }> } => JSON.parse(fs.readFileSync(file, 'utf8'));

async function record(script: Parameters<typeof mockModel>[0], calls: GenerateOptions[]): Promise<void> {
  const provider = recordReplay(mockModel(script), { cassette: file, mode: 'record' });
  for (const call of calls) await provider.generate(call);
}

describe('recordReplay record then replay', () => {
  it('replays recorded responses without constructing the wrapped provider', async () => {
    const live = recordReplay(
      mockModel(
        [
          { toolCalls: [{ name: 'lookup', args: { id: 7 } }], usage: { inputTokens: 10, outputTokens: 4 } },
          { text: 'done', usage: { inputTokens: 20, outputTokens: 2 } },
        ],
        { defaultModel: 'gpt-test' }
      ),
      { cassette: file, mode: 'record' }
    );
    const first = await live.generate(ask('one'));
    const second = await live.generate(ask('two'));

    const replay = recordReplay(forbidden, { cassette: file, mode: 'replay' });

    expect(replay.mode).toBe('replay');
    expect(replay.defaultModel).toBe('gpt-test');
    expect(replay.name).toBe('mock');
    expect(await replay.generate(ask('one'))).toEqual(first);
    expect(await replay.generate(ask('two'))).toEqual(second);
    expect(await replay.getModels()).toEqual(['gpt-test']);
    expect(replay.supportsTools('x') && replay.supportsStreaming('x')).toBe(true);
  });

  it('replays a provider/model spec resolved without an API key (LOU-R10)', async () => {
    await recordReplay(mockModel(['ok']), { cassette: file, mode: 'record' }).generate(ask('hi', { model: 'gpt-4o-mini' }));

    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('LOUSHO_EVAL_CASSETTES', 'replay');
    try {
      // Resolving the spec needs no key: the cassette answers every call.
      const replay = recordReplay(resolveProvider('openai/gpt-4o-mini'), { cassette: file, mode: 'replay' });
      expect((await replay.generate(ask('hi', { model: 'gpt-4o-mini' }))).text).toBe('ok');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('replays an agent run end to end with the same usage numbers', async () => {
    const lookup = defineTool({
      name: 'lookup',
      description: 'Look up an order',
      input: z.object({ id: z.number() }),
      execute: async ({ id }) => ({ id, status: 'shipped' }),
    });
    const build = (provider: ReturnType<typeof recordReplay>) =>
      createAgent({ prompt: 'You help.', provider, tools: { lookup } });
    const script = [
      { toolCalls: [{ name: 'lookup', args: { id: 7 } }], usage: { inputTokens: 5, outputTokens: 1 } },
      { text: 'Order 7 shipped', usage: { inputTokens: 9, outputTokens: 3 } },
    ];

    const recorded = await build(recordReplay(mockModel(script), { cassette: file, mode: 'record' })).send('status?');
    const replayed = await build(recordReplay(forbidden, { cassette: file, mode: 'replay' })).send('status?');

    expect(replayed.text).toBe('Order 7 shipped');
    expect(replayed.text).toBe(recorded.text);
    expect(readJson().entries).toHaveLength(2);
  });

  it('writes a versioned, stable, 2-space indented cassette without rawResponse', async () => {
    const model = mockModel(['hi']);
    const provider = recordReplay(
      { ...model, generate: async (o) => ({ ...(await model.generate(o)), rawResponse: { headers: { authorization: 'x' } } }) } as typeof model,
      { cassette: file, mode: 'record' }
    );
    await provider.generate(ask('hello', { temperature: 0.2, maxTokens: 50 }));

    const text = fs.readFileSync(file, 'utf8');
    const json = JSON.parse(text);

    expect(text).toBe(`${JSON.stringify(json, null, 2)}\n`);
    expect(Object.keys(json)).toEqual(['version', 'sdkVersion', 'recordedAt', 'provider', 'entries']);
    expect(json.version).toBe(1);
    expect(typeof json.sdkVersion).toBe('string');
    expect(json.entries[0].request).toEqual({
      model: 'mock-model',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      temperature: 0.2,
      maxTokens: 50,
    });
    expect(text).not.toContain('authorization');
  });
});

describe('recordReplay mismatches', () => {
  it('throws CassetteMismatchError with a readable diff and the re-record hint', async () => {
    await record(['a'], [ask('What is the refund policy for order 1234?')]);
    const replay = recordReplay(undefined, { cassette: file, mode: 'replay' });

    const error = await replay.generate(ask('What is the refund policy for order 9999?')).catch((e) => e);

    expect(error).toBeInstanceOf(CassetteMismatchError);
    expect(error.name).toBe('CassetteMismatchError');
    expect(error.callNumber).toBe(1);
    expect(error.message).toContain('First difference at request.messages[0].content');
    expect(error.message).toContain('order 1234');
    expect(error.message).toContain('order 9999');
    expect(error.message).toContain('LOUSHO_RECORD=1');
  });

  it('uses rerecordHint instead of the default hint when given', async () => {
    await record(['a'], [ask('one')]);
    const replay = recordReplay(undefined, { cassette: file, mode: 'replay', rerecordHint: 'Run npm run record.' });
    const mismatch = await replay.generate(ask('two')).catch((e) => e);
    const again = recordReplay(undefined, { cassette: file, mode: 'replay', rerecordHint: 'Run npm run record.' });
    await again.generate(ask('one'));
    const exhausted = await again.generate(ask('one')).catch((e) => e);
    expect(mismatch.message).toContain('Run npm run record.');
    expect(mismatch.message).not.toContain('LOUSHO_RECORD');
    expect(exhausted.message).toContain('all were used');
    expect(exhausted.message).toContain('Run npm run record.');
  });

  it('detects changed tools, schemas, temperature and a missing message', async () => {
    const tool = (shape: z.ZodRawShape) => ({
      type: 'function' as const,
      // The SDK hands a zod schema through as `parameters` (generateStep.ts casts it); the fingerprint reads it as one.
      function: { name: 't', description: 'd', parameters: z.object(shape) as unknown as Record<string, unknown> },
    });
    await record(['a'], [ask('q', { tools: [tool({ city: z.string() })], temperature: 0 })]);
    const replay = (): ReturnType<typeof recordReplay> => recordReplay(undefined, { cassette: file, mode: 'replay' });

    const schema = await replay().generate(ask('q', { tools: [tool({ city: z.number() })], temperature: 0 })).catch((e) => e);
    const temp = await replay().generate(ask('q', { tools: [tool({ city: z.string() })], temperature: 1 })).catch((e) => e);
    const same = await replay().generate(ask('q', { tools: [tool({ city: z.string() })], temperature: 0 }));

    expect(schema.message).toContain('request.tools[0].parameters.properties.city.type');
    expect(temp.message).toContain('request.temperature');
    expect(same.text).toBe('a');
  });

  it('fails clearly when the agent makes more calls than were recorded', async () => {
    await record(['a'], [ask('q')]);
    const replay = recordReplay(undefined, { cassette: file, mode: 'replay' });
    await replay.generate(ask('q'));

    await expect(replay.generate(ask('q'))).rejects.toThrow(/Call #2 has no recorded entry.*holds 1 entry/s);
  });

  it('does not let a generate entry answer a stream call', async () => {
    await record(['a'], [ask('q')]);
    const replay = recordReplay(undefined, { cassette: file, mode: 'replay' });

    await expect(replay.stream(ask('q'))).rejects.toThrow(/First difference at kind/);
  });

  it('rejects a missing, corrupt or wrong-version cassette with a fix', () => {
    expect(() => recordReplay(undefined, { cassette: file, mode: 'replay' })).toThrow(/not found.*LOUSHO_RECORD=1/s);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{nope');
    expect(() => recordReplay(undefined, { cassette: file, mode: 'replay' })).toThrow(/not valid JSON/);
    fs.writeFileSync(file, JSON.stringify({ version: 99, entries: [] }));
    expect(() => recordReplay(undefined, { cassette: file, mode: 'replay' })).toThrow(/version 99.*Re-record/s);
    fs.writeFileSync(file, JSON.stringify({ version: 1, entries: 3 }));
    expect(() => recordReplay(undefined, { cassette: file, mode: 'replay' })).toThrow(/malformed/);
  });
});

describe('cassette errors through agent.send() (LOU-R13)', () => {
  const build = (provider: ReturnType<typeof recordReplay>) =>
    createAgent({ provider, prompt: 'You handle refunds.' });

  it('a replay mismatch rejects as CassetteMismatchError, not a CompactedLLMProviderError', async () => {
    await build(recordReplay(mockModel(['refunded']), { cassette: file, mode: 'record' })).send('Refund order 42');

    const error = await build(recordReplay(undefined, { cassette: file, mode: 'replay' }))
      .send('Refund order 9999')
      .catch((e) => e);

    expect(error).toBeInstanceOf(CassetteMismatchError);
    expect(error).not.toBeInstanceOf(CompactedLLMProviderError);
    expect(error.code).toBe('LOUSHO_CASSETTE_INVALID');
    expect(error.cassette).toBe(file);
    expect(error.callNumber).toBe(1);
    expect(error.message).toContain('First difference at');
  });

  it('stays typed when the run streams its model calls (send() with a listener)', async () => {
    await build(recordReplay(mockModel(['refunded']), { cassette: file, mode: 'record' })).send('Refund order 42');

    const replay = recordReplay(undefined, { cassette: file, mode: 'replay' });
    const error = await createAgent({ provider: replay, prompt: 'You handle refunds.', onEvent: () => {} })
      .send('Refund order 9999')
      .catch((e) => e);

    expect(error).toBeInstanceOf(CassetteMismatchError);
    expect(error).not.toBeInstanceOf(CompactedLLMProviderError);
  });

  it('rejects typed when the mismatch is thrown through the interception seam, exported here', async () => {
    // What `lousho eval --record` / `--replay` installs (src/evals/cassettes.ts):
    // an interceptor that answers every model call with a recordReplay wrapper.
    setProviderInterceptor((provider) => recordReplay(provider, { cassette: file, mode: 'record' }));
    await createAgent({ provider: mockModel(['refunded']), prompt: 'You handle refunds.' }).send('Refund order 42');

    setProviderInterceptor(() => recordReplay(undefined, { cassette: file, mode: 'replay' }));
    const error = await createAgent({ provider: mockModel(['live']), prompt: 'You handle refunds.' })
      .send('Refund order 9999')
      .catch((e) => e);

    expect(error).toBeInstanceOf(CassetteMismatchError);
    expect(error.code).toBe('LOUSHO_CASSETTE_INVALID');
    expect(error).not.toBeInstanceOf(CompactedLLMProviderError);
  });

  it('a cassette error the interceptor itself throws stays typed through send()', async () => {
    // What `lousho eval --replay` throws when a case has no cassette.
    const unreadable = new SDKError('no cassette for "Refund flow [polite]". Record it with: npx lousho eval --record', 'LOUSHO_CASSETTE_INVALID');
    setProviderInterceptor(() => {
      throw unreadable;
    });

    const error = await createAgent({ provider: mockModel(['live']), prompt: 'You handle refunds.' })
      .send('Refund order 42')
      .catch((e) => e);

    expect(error).toBe(unreadable);
    expect(error).not.toBeInstanceOf(CompactedLLMProviderError);
  });
});

describe("recordReplay match: 'request'", () => {
  it('finds entries by fingerprint regardless of call order', async () => {
    await record(['answer a', 'answer b'], [ask('a'), ask('b')]);
    const replay = recordReplay(forbidden, { cassette: file, mode: 'replay', match: 'request' });

    const [b, a] = await Promise.all([replay.generate(ask('b')), replay.generate(ask('a'))]);

    expect([a.text, b.text]).toEqual(['answer a', 'answer b']);
  });

  it('uses identical requests in recorded order and errors when none remain or none match', async () => {
    await record(['first', 'second'], [ask('same'), ask('same')]);
    const replay = recordReplay(undefined, { cassette: file, mode: 'replay', match: 'request' });

    expect((await replay.generate(ask('same'))).text).toBe('first');
    expect((await replay.generate(ask('same'))).text).toBe('second');
    await expect(replay.generate(ask('same'))).rejects.toThrow(/no recorded entry/);

    const fresh = recordReplay(undefined, { cassette: file, mode: 'replay', match: 'request' });
    await expect(fresh.generate(ask('other'))).rejects.toThrow(/No unused recorded request matches[\s\S]*request.messages\[0\].content/);
  });
});

describe('recordReplay normalization', () => {
  it('ignores timestamps, dates, uuids and generated ids when matching', async () => {
    await record(
      ['ok'],
      [
        ask('Today is 2026-10-01T09:15:00.000Z, session 123e4567-e89b-12d3-a456-426614174000, ref call_AbC12345xyz'),
      ]
    );
    const replay = recordReplay(undefined, { cassette: file, mode: 'replay' });

    const result = await replay.generate(
      ask('Today is 2027-01-05T18:00:01.500Z, session 99999999-e89b-12d3-a456-426614174000, ref call_ZzZ98765abc')
    );

    expect(result.text).toBe('ok');
    expect(fs.readFileSync(file, 'utf8')).toContain('Today is <timestamp>, session <uuid>, ref <id>');
  });

  it('matches tool calls structurally, ignoring the generated tool-call ids', async () => {
    const turn = (id: string): GenerateOptions => ({
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: '', toolCalls: [{ id, type: 'function', function: { name: 'a', arguments: '{"y":2,"x":1}' } }] },
        { role: 'tool', content: '{"ok":true}', toolCallId: id, toolName: 'a' },
      ],
    });
    await record(['done'], [turn('call_1')]);
    const replay = recordReplay(undefined, { cassette: file, mode: 'replay' });

    const result = await replay.generate({
      messages: turn('toolu_different').messages.map((m) =>
        m.toolCalls ? { ...m, toolCalls: [{ ...m.toolCalls[0], function: { name: 'a', arguments: '{"x":1,"y":2}' } }] } : m
      ),
    });

    expect(result.text).toBe('done');
  });

  it('applies a custom normalize hook on record and replay', async () => {
    const normalize = (r: GenerateOptions): GenerateOptions => ({
      ...r,
      messages: r.messages.map((m) => ({ ...m, content: textOf(m).replace(/user-\d+/g, 'user-N') })),
    });
    await record(['ok'], [ask('hello user-1')]);
    fs.rmSync(file);
    const provider = recordReplay(mockModel(['ok']), { cassette: file, mode: 'record', normalize });
    await provider.generate(ask('hello user-1'));

    const replay = recordReplay(undefined, { cassette: file, mode: 'replay', normalize });

    expect((await replay.generate(ask('hello user-777'))).text).toBe('ok');
    expect(readJson().entries[0].request.messages[0].content).toBe('hello user-N');
  });
});

describe('recordReplay with multimodal content (LOU-V11)', () => {
  const look = (image: string | Uint8Array): GenerateOptions => ({
    messages: [{ role: 'user', content: [{ type: 'text', text: 'What is this?' }, { type: 'image', image, mimeType: 'image/png' }] }],
  });

  it('stores the text and a digest of each image, and matches on both', async () => {
    await record(['a cat'], [look(new Uint8Array([1, 2, 3]))]);
    const stored = readJson().entries[0].request.messages[0];

    expect(stored).toEqual({ role: 'user', content: 'What is this?', attachments: [expect.stringMatching(/^image image\/png fnv1a:[0-9a-f]{8}$/)] });

    const replay = recordReplay(undefined, { cassette: file, mode: 'replay' });
    expect((await replay.generate(look(new Uint8Array([1, 2, 3])))).text).toBe('a cat');
    await expect(replay.generate(look(new Uint8Array([9, 9, 9])))).rejects.toThrow(CassetteMismatchError);
  });

  it('keeps an image URL as is and string content unchanged', async () => {
    await record(['a cat', 'ok'], [look('https://example.com/cat.png'), ask('plain')]);

    expect(readJson().entries.map((entry) => entry.request.messages[0])).toEqual([
      { role: 'user', content: 'What is this?', attachments: ['image image/png https://example.com/cat.png'] },
      { role: 'user', content: 'plain' },
    ]);
  });
});

describe('recordReplay redaction', () => {
  it('redacts API-key-like strings and bearer tokens from requests and responses', async () => {
    const anthropic = `sk-ant-${'a1B2c3D4'.repeat(4)}`;
    const openai = `sk-proj-${'Z9y8X7w6'.repeat(4)}`;
    const model = mockModel([
      { text: `your key is ${openai}`, toolCalls: [{ name: 'send', args: { auth: 'Bearer abcdef1234567890.token' } }] },
    ]);
    const provider = recordReplay(model, { cassette: file, mode: 'record' });

    await provider.generate(ask(`use ${anthropic} and Authorization: Bearer eyJhbGciOi.payload-1234`));

    const text = fs.readFileSync(file, 'utf8');
    expect(text).not.toContain(anthropic);
    expect(text).not.toContain(openai);
    expect(text).not.toContain('eyJhbGciOi');
    expect(text).not.toContain('abcdef1234567890');
    expect(text.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(4);
    const replay = recordReplay(undefined, { cassette: file, mode: 'replay' });
    expect((await replay.generate(ask(`use ${anthropic} and Authorization: Bearer eyJhbGciOi.payload-1234`))).text).toBe(
      'your key is [REDACTED]'
    );
  });

  it('applies the custom redact function to every recorded string', async () => {
    const provider = recordReplay(mockModel(['ssn is 123-45-6789']), {
      cassette: file,
      mode: 'record',
      redact: (t) => t.replace(/\d{3}-\d{2}-\d{4}/g, '<ssn>'),
    });

    await provider.generate(ask('my ssn is 123-45-6789'));

    const text = fs.readFileSync(file, 'utf8');
    expect(text).not.toContain('123-45-6789');
    expect(text).toContain('ssn is <ssn>');
  });
});

describe('recordReplay persistence', () => {
  it('writes after every call so a test that fails midway leaves a valid cassette', async () => {
    const provider = recordReplay(mockModel(['one', 'two']), { cassette: file, mode: 'record' });
    await provider.generate(ask('a'));

    expect(readJson().entries).toHaveLength(1);
    await provider.generate(ask('b'));
    expect(readJson().entries).toHaveLength(2);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['flow.json']);
  });

  it('keeps the previous cassette intact and leaves no temp file when the write fails', async () => {
    const provider = recordReplay(mockModel(['one', 'two']), { cassette: file, mode: 'record' });
    await provider.generate(ask('a'));
    const before = fs.readFileSync(file, 'utf8');
    const rename = vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(new Error('disk full'));

    await expect(provider.generate(ask('b'))).rejects.toThrow('disk full');

    rename.mockRestore();
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['flow.json']);
  });

  it('save() writes an empty cassette and is a no-op in replay', async () => {
    const provider = recordReplay(mockModel([]), { cassette: file, mode: 'record' });
    await provider.save();
    expect(readJson().entries).toEqual([]);

    const replay = recordReplay(undefined, { cassette: file, mode: 'replay' });
    const before = fs.statSync(file).mtimeMs;
    await replay.save();
    expect(fs.statSync(file).mtimeMs).toBe(before);
  });

  it('keeps parallel calls in call-start order', async () => {
    const provider = recordReplay(mockModel([{ text: 'slow', delayMs: 30 }, 'fast']), { cassette: file, mode: 'record' });

    await Promise.all([provider.generate(ask('slow')), provider.generate(ask('fast'))]);

    expect(readJson().entries.map((e) => e.request.messages[0].content)).toEqual(['slow', 'fast']);
  });

  it('starts a fresh cassette each record session', async () => {
    await record(['a', 'b'], [ask('1'), ask('2')]);
    await record(['c'], [ask('3')]);

    expect(readJson().entries).toHaveLength(1);
  });

  it('re-recording an unchanged run rewrites the file byte for byte, keeping recordedAt (docs-qa F14)', async () => {
    await record(['a', 'b'], [ask('1'), ask('2')]);
    const header = JSON.parse(fs.readFileSync(file, 'utf8')) as { recordedAt: string };
    header.recordedAt = '2020-01-01T00:00:00.000Z';
    fs.writeFileSync(file, `${JSON.stringify(header, null, 2)}\n`);
    const before = fs.readFileSync(file, 'utf8');

    await record(['a', 'b'], [ask('1'), ask('2')]);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);

    await record(['a', 'changed'], [ask('1'), ask('2')]);
    expect((JSON.parse(fs.readFileSync(file, 'utf8')) as { recordedAt: string }).recordedAt).not.toBe('2020-01-01T00:00:00.000Z');
  });
});

describe('recordReplay errors', () => {
  it('records provider rejections and replays them with the same name and message', async () => {
    const boom = Object.assign(new Error('rate limited, retry in 5s'), { name: 'RateLimitError' });
    const provider = recordReplay(mockModel([{ error: boom }, 'ok']), { cassette: file, mode: 'record' });
    await expect(provider.generate(ask('a'))).rejects.toBe(boom);
    await provider.generate(ask('b'));

    const replay = recordReplay(forbidden, { cassette: file, mode: 'replay' });
    const error = await replay.generate(ask('a')).catch((e) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('RateLimitError');
    expect(error.message).toBe('rate limited, retry in 5s');
    expect((await replay.generate(ask('b'))).text).toBe('ok');
  });

  it('replays a rejected stream() call', async () => {
    const provider = recordReplay(mockModel([{ error: new Error('nope') }]), { cassette: file, mode: 'record' });
    await expect(provider.stream(ask('a'))).rejects.toThrow('nope');

    const replay = recordReplay(undefined, { cassette: file, mode: 'replay' });

    await expect(replay.stream(ask('a'))).rejects.toThrow('nope');
  });

  it('rejects immediately when the call is already aborted', async () => {
    await record(['a'], [ask('q')]);
    const replay = recordReplay(undefined, { cassette: file, mode: 'replay' });

    await expect(replay.generate(ask('q', { signal: AbortSignal.abort(new Error('stop')) }))).rejects.toThrow('stop');
  });
});

describe('recordReplay stream()', () => {
  const collect = async (iterable: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> => {
    const out: StreamChunk[] = [];
    for await (const chunk of iterable) out.push(chunk);
    return out;
  };

  it('round-trips chunks, text, usage, finish reason and tool calls', async () => {
    const model = mockModel([
      { text: 'hello brave world', toolCalls: [{ name: 'x', args: { a: 1 } }], usage: { inputTokens: 3, outputTokens: 5 } },
    ]);
    const live = await recordReplay(model, { cassette: file, mode: 'record' }).stream(ask('s'));
    const liveChunks = await collect(live.fullStream);

    const replayed = await recordReplay(forbidden, { cassette: file, mode: 'replay' }).stream(ask('s'));

    expect(await collect(replayed.fullStream)).toEqual(liveChunks);
    expect(await replayed.text).toBe('hello brave world');
    expect(await replayed.usage).toEqual({ promptTokens: 3, completionTokens: 5, totalTokens: 8 });
    expect(await replayed.finishReason).toBe('tool_calls');
    expect((await replayed.toolCalls).map((c) => c.function.name)).toEqual(['x']);
    const texts: string[] = [];
    for await (const part of replayed.textStream) texts.push(part);
    expect(texts.join('')).toBe('hello brave world');
  });

  it('replays without delays by default and with recorded timing when asked', async () => {
    const slowStream = {
      ...mockModel(['x']),
      stream: async () => ({
        fullStream: (async function* (): AsyncGenerator<StreamChunk> {
          yield { type: 'text-delta', textDelta: 'a' };
          await new Promise((r) => setTimeout(r, 60));
          yield { type: 'text-delta', textDelta: 'b' };
          yield { type: 'finish', finishReason: 'stop' };
        })(),
        textStream: (async function* () {})(),
        text: Promise.resolve('ab'),
        usage: Promise.resolve({ promptTokens: 1, completionTokens: 1, totalTokens: 2 }),
        finishReason: Promise.resolve('stop'),
        toolCalls: Promise.resolve([]),
      }),
    };
    const recorder = recordReplay(slowStream, { cassette: file, mode: 'record' });
    await recorder.stream(ask('s'));

    const delaysRequested = async (replayTiming: boolean): Promise<number[]> => {
      const timers = vi.spyOn(globalThis, 'setTimeout');
      const replay = await recordReplay(undefined, { cassette: file, mode: 'replay', replayTiming }).stream(ask('s'));
      await collect(replay.fullStream);
      const delays = timers.mock.calls.map((call) => Number(call[1]));
      timers.mockRestore();
      return delays;
    };

    expect(await delaysRequested(false)).toEqual([]);
    expect((await delaysRequested(true)).some((ms) => ms >= 50)).toBe(true);
  });

  it('records error chunks', async () => {
    const withError = {
      ...mockModel(['x']),
      stream: async () => ({
        fullStream: (async function* (): AsyncGenerator<StreamChunk> {
          yield { type: 'error', error: Object.assign(new Error('mid-stream'), { name: 'StreamError' }) };
        })(),
        textStream: (async function* () {})(),
        text: Promise.resolve(''),
        usage: Promise.resolve({ promptTokens: 0, completionTokens: 0, totalTokens: 0 }),
        finishReason: Promise.resolve('error'),
        toolCalls: Promise.resolve([]),
      }),
    };
    await recordReplay(withError, { cassette: file, mode: 'record' }).stream(ask('s'));

    const replay = await recordReplay(undefined, { cassette: file, mode: 'replay' }).stream(ask('s'));
    const [chunk] = await collect(replay.fullStream);

    expect(chunk.error?.name).toBe('StreamError');
    expect(chunk.error?.message).toBe('mid-stream');
  });
});

describe("recordReplay mode 'auto' and construction", () => {
  it('records when the cassette is missing, then replays once it exists', async () => {
    const first = recordReplay(mockModel(['recorded']), { cassette: file });
    expect(first.mode).toBe('record');
    await first.generate(ask('q'));

    const second = recordReplay(forbidden, { cassette: file });

    expect(second.mode).toBe('replay');
    expect((await second.generate(ask('q'))).text).toBe('recorded');
  });

  it('only calls a lazy factory when recording', () => {
    const factory = vi.fn(() => mockModel(['x']));

    recordReplay(factory, { cassette: file, mode: 'record' });
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('explains how to fix record mode without a provider', () => {
    expect(() => recordReplay(undefined, { cassette: file, mode: 'record' })).toThrow(/needs a provider to record from/);
  });
});
