import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { mockModel, type MockTurn } from '../testing';
import { parseChatArgs, runChat } from './chat';
import { runChatRepl } from './chatRepl';

const lookup = defineTool({
  name: 'lookup',
  description: 'Look a topic up',
  input: z.object({ q: z.string() }),
  execute: ({ q }) => `found ${q}`,
});
const ping = defineTool({
  name: 'ping',
  description: 'Reply with pong',
  input: z.object({}),
  execute: () => 'pong',
  needsApproval: true,
});

function sink() {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  return { stream, text: () => chunks.join('') };
}

async function* scripted(lines: string[]) {
  yield* lines;
}

/** Runs the REPL over `lines` with a fresh mock-model agent; `built` records the model asked of each build. */
async function converse(lines: string[], turns: MockTurn[], extra: { askQuestion?: boolean } = {}) {
  const out = sink();
  const err = sink();
  const model = mockModel(turns);
  const built: Array<string | undefined> = [];
  const code = await runChatRepl({
    input: scripted(lines),
    output: out.stream,
    errorOutput: err.stream,
    sessionId: 'test',
    createAgent: async (requested) => {
      built.push(requested);
      return createAgent({
        instructions: 'You are a test agent.',
        provider: model,
        tools: [lookup, ping],
        ...extra,
      });
    },
  });
  return { code, model, built, out: out.text(), err: err.text() };
}

describe('loushy chat REPL', () => {
  it('streams a reply, shows tool calls as dim lines and prints usage', async () => {
    const { code, out, model } = await converse(
      ['look up cats', '/quit'],
      [
        {
          toolCalls: [{ name: 'lookup', args: { q: 'cats' } }],
          usage: { inputTokens: 8, outputTokens: 2 },
        },
        {
          text: 'Cats are great.',
          usage: { inputTokens: 12, outputTokens: 4 },
        },
      ]
    );
    expect(code).toBe(0);
    expect(out).toContain('[lookup] {"q":"cats"}\n  -> found cats\n');
    expect(out).toContain('Cats are great.\n');
    expect(out).toMatch(/\[usage\] 20 in \/ 6 out tokens/);
    expect(model.calls).toHaveLength(2);
  });

  it('keeps one session across lines, and dims tool lines only when color is on', async () => {
    const out = sink();
    const model = mockModel(['Hi Ali.', 'You are Ali.']);
    await runChatRepl({
      input: scripted(['I am Ali.', 'Who am I?']),
      output: out.stream,
      color: true,
      createAgent: async () => createAgent({ instructions: 'x', provider: model }),
    });
    expect(model.calls[1].messages.map((m) => String(m.content))).toContain('Hi Ali.');
    expect(out.text()).toContain('\x1b[2mloushy chat: session ');
    expect(out.text()).toContain('You are Ali.\n');
  });

  it('asks Approve <tool>(args)? and runs the tool on y', async () => {
    const { out, model } = await converse(['ping it', 'y', '/quit'], [{ toolCalls: [{ name: 'ping' }] }, 'The tool said pong.']);
    expect(out).toContain('Approve ping({})? [y/N] ');
    expect(out).toContain('  -> pong');
    expect(out).toContain('The tool said pong.');
    expect(JSON.stringify(model.calls[1].messages)).toContain('pong');
  });

  it('rejects the call on n (and on anything but yes), so the tool never runs', async () => {
    const { out, model } = await converse(['ping it', 'n', '/quit'], [{ toolCalls: [{ name: 'ping' }] }, 'Understood, not pinging.']);
    expect(out).toContain('Approve ping({})? [y/N] ');
    expect(out).not.toContain('  -> pong');
    expect(out).toContain('Understood, not pinging.');
    expect(JSON.stringify(model.calls[1].messages)).not.toContain('pong');
  });

  it('shows a question with numbered options and answers by number', async () => {
    const { out, model } = await converse(
      ['plan a trip', '2', '/quit'],
      [
        {
          toolCalls: [
            {
              name: 'ask_question',
              args: { question: 'Where to?', options: ['Porto', 'Lisbon'] },
            },
          ],
        },
        'Lisbon it is.',
      ],
      { askQuestion: true }
    );
    expect(out).toContain('? Where to?\n  1) Porto\n  2) Lisbon\n');
    expect(out).toContain('Answer (number or text): ');
    expect(out).toContain('Lisbon it is.');
    expect(JSON.stringify(model.calls[1].messages)).toContain('Lisbon');
  });

  it('takes free text for a question, and asks again for an empty answer', async () => {
    const { out, model } = await converse(
      ['plan a trip', '', 'Madeira', '/quit'],
      [
        {
          toolCalls: [
            {
              name: 'ask_question',
              args: { question: 'Where to?', options: ['Porto', 'Lisbon'] },
            },
          ],
        },
        'Madeira then.',
      ],
      { askQuestion: true }
    );
    expect(out).toContain('Pick a number from 1 to 2.');
    expect(JSON.stringify(model.calls[1].messages)).toContain('Madeira');
  });

  it('/new starts a session without the earlier history, and /history prints the transcript', async () => {
    const { out, model } = await converse(['my name is Ali', '/history', '/new', 'who am I?', '/history', '/quit'], ['Nice to meet you.', 'No idea.']);
    expect(out).toContain('you: my name is Ali\nassistant: Nice to meet you.\n');
    expect(out).toContain('assistant: Nice to meet you.');
    expect(out).toMatch(/New session chat-[0-9a-f]{8}\./);
    expect(model.calls[1].messages.filter((m) => m.role === 'user').map((m) => m.content)).toEqual(['who am I?']);
    expect(out.split('you: who am I?').length).toBe(2);
    expect(out.split('you: my name is Ali').length).toBe(2);
  });

  it('/clear empties the current session and /compact reports its size', async () => {
    const { out, model } = await converse(['my name is Ali', '/compact', '/clear', '/history', 'who am I?', '/quit'], ['Nice to meet you.', 'No idea.']);
    expect(out).toMatch(/Compacted: 2 -> 2 messages, ~\d+ -> ~\d+ tokens\./);
    expect(out).toContain('Conversation cleared.');
    expect(out).toContain('(no messages yet)');
    expect(model.calls[1].messages.filter((m) => m.role === 'user').map((m) => m.content)).toEqual(['who am I?']);
  });

  it('/history says so for an empty session, and an unknown command lists the commands', async () => {
    const { out } = await converse(['/history', '/nope', '/quit'], []);
    expect(out).toContain('(no messages yet)');
    expect(out).toContain("Unknown command '/nope'. Commands: /new, /compact, /clear, /model <provider/model>, /history, /quit");
  });

  it('/model rebuilds the agent with the new model, and keeps the old one when that fails', async () => {
    const out = sink();
    const err = sink();
    const built: Array<string | undefined> = [];
    await runChatRepl({
      input: scripted(['/model openai/gpt-4o', '/model bad', 'hi']),
      output: out.stream,
      errorOutput: err.stream,
      model: 'mock/start',
      createAgent: async (model) => {
        built.push(model);
        if (model === 'bad') throw new Error('unknown provider [LOUSHY_PROVIDER_UNKNOWN]');
        return createAgent({ instructions: 'x', provider: mockModel(['ok']) });
      },
    });
    expect(built).toEqual(['mock/start', 'openai/gpt-4o', 'bad']);
    expect(out.text()).toContain('Model is now openai/gpt-4o.');
    expect(err.text()).toContain('error: unknown provider [LOUSHY_PROVIDER_UNKNOWN]');
    expect(out.text()).toContain('ok\n');
  });

  it('reports a failing turn with its error code and keeps going', async () => {
    const { err, out } = await converse(['hi', 'again', '/quit'], [{ error: new Error('boom') }, 'Recovered.']);
    expect(err).toContain('error: ');
    expect(err).toContain('boom');
    expect(out).toContain('Recovered.');
  });

  it('streams the continuation after y, and asks again when it pauses a second time (LOU-D32.2)', async () => {
    const { out } = await converse(['ping twice', 'y', 'y', '/quit'], [{ toolCalls: [{ name: 'ping' }] }, { toolCalls: [{ name: 'ping' }] }, 'Both done.']);
    expect(out.match(/Approve ping\(\{\}\)\? \[y\/N\] /g)).toHaveLength(2);
    expect(out).toContain('-> pong');
    expect(out).toContain('Both done.');
  });

  it('declines a pending approval when the input ends, and still closes the agent', async () => {
    const { out, code } = await converse(['ping it'], [{ toolCalls: [{ name: 'ping' }] }, 'Not pinging.']);
    expect(code).toBe(0);
    expect(out).toContain('Approve ping({})? [y/N] ');
    expect(out).toContain('Not pinging.');
  });
});

describe('loushy chat command', () => {
  const fixtures = path.join(__dirname, '__fixtures__');
  const run = async (
    args: string[],
    lines: string[],
    overrides: Parameters<typeof runChat>[1] extends infer T ? (T extends { overrides?: infer O } ? O : never) : never
  ) => {
    const stdin = new PassThrough();
    const out = sink();
    const err = sink();
    stdin.end(`${lines.join('\n')}\n`);
    const code = await runChat(args, {
      stdin,
      stdout: out.stream,
      stderr: err.stream,
      overrides,
    });
    return { code, out: out.text(), err: err.text() };
  };

  it('fails with LOUSHY_CONFIG_INVALID for a path that does not exist', async () => {
    const { code, err, out } = await run([path.join(fixtures, 'nope', 'agent.ts')], ['hi'], undefined);
    expect(code).toBe(1);
    expect(err).toContain('LOUSHY_CONFIG_INVALID');
    expect(err).toContain('does not exist');
    expect(out).toBe('');
  });

  it('fails with LOUSHY_SPEC_UNSUPPORTED_FORMAT for an unsupported file type', async () => {
    const file = path.join(os.tmpdir(), `loushy-chat-${process.pid}.txt`);
    fs.writeFileSync(file, 'x');
    const { code, err } = await run([file], [], undefined);
    fs.rmSync(file);
    expect(code).toBe(1);
    expect(err).toContain('LOUSHY_SPEC_UNSUPPORTED_FORMAT');
  });

  it('fails with LOUSHY_CONFIG_INVALID and the usage for a missing path, an unknown flag or a bad --store', () => {
    for (const args of [[], ['a.yaml', '--bogus'], ['a.yaml', '--store', 'redis:x']]) {
      expect(() => parseChatArgs(args)).toThrow(/LOUSHY_CONFIG_INVALID/);
    }
    expect(parseChatArgs(['agent.yaml', '--model=openai/gpt-4o', '--session', 's1', '--store', 'sqlite:./c.db'])).toEqual({
      path: 'agent.yaml',
      model: 'openai/gpt-4o',
      session: 's1',
      sqlite: './c.db',
    });
  });

  it('chats with an agent directory over readline', async () => {
    const { code, out } = await run([path.join(fixtures, 'dev-agent'), '--session', 'dir1'], ['hello', '/quit'], {
      provider: mockModel([
        {
          text: 'Hello from the dir.',
          usage: { inputTokens: 5, outputTokens: 3 },
        },
      ]),
    });
    expect(code).toBe(0);
    expect(out).toContain('session dir1');
    expect(out).toContain('Hello from the dir.');
    expect(out).toContain('[usage]');
  });

  it('chats with a TS module, approving a tool', async () => {
    const { out } = await run([path.join(fixtures, 'dev-module', 'config.ts')], ['ping it', 'yes', '/quit'], {
      provider: mockModel([{ toolCalls: [{ name: 'ping' }] }, 'Pong received.']),
      tools: [ping],
    });
    expect(out).toContain('Approve ping({})? [y/N] ');
    expect(out).toContain('Pong received.');
  });

  it('chats with a spec file, and rejects an invalid session id', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loushy-chat-'));
    const spec = path.join(dir, 'agent.json');
    fs.writeFileSync(
      spec,
      JSON.stringify({
        name: 'spec-agent',
        prompt: 'Be brief.',
        provider: { type: 'mock', model: 'mock-model-1' },
      })
    );
    expect((await run([spec, '--session', 'not valid!'], [], undefined)).err).toContain('LOUSHY_SESSION_ID_INVALID');
    const { code, out } = await run([spec], ['hi', '/quit'], undefined);
    fs.rmSync(dir, { recursive: true });
    expect(code).toBe(0);
    expect(out).toContain('loushy chat: session chat-');
  });

  it('keeps sessions in --store sqlite:<file> across runs', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loushy-chat-'));
    const db = path.join(dir, 'chat.db');
    const target = path.join(fixtures, 'dev-agent');
    const args = [target, '--session', 'keep', '--store', `sqlite:${db}`];
    await run(args, ['remember me', '/quit'], {
      provider: mockModel(['Remembered.']),
    });
    const { out } = await run(args, ['/history', '/quit'], {
      provider: mockModel([]),
    });
    fs.rmSync(dir, { recursive: true, force: true });
    expect(out).toContain('you: remember me');
    expect(out).toContain('assistant: Remembered.');
  });
});
