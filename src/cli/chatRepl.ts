/**
 * The REPL behind `loushy chat` (LOU-D33): reads lines, streams each turn's
 * events, asks for approvals and questions, and runs the slash commands. It
 * takes its input, output and agent factory as arguments, so tests drive it
 * with scripted lines and a `mockModel` agent; src/cli/chat.ts wires readline.
 */
import * as readline from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type { SimpleAgent } from '../createAgent';
import type { AgentEvent, AgentEventOf, AgentEventType, AgentEventUsage } from '../execution/agentEvents';
import type { ApprovalQuestion, PendingApproval } from '../execution/ApprovalGate';
import { textOf } from '../providers/content';
import type { Message } from '../providers/llm';
import type { AgentSession } from '../session/AgentSession';
import { assertSessionId } from '../session/sessionStore';
import { memoryStore, type AgentStore } from '../storage/agentStore';
import { newId } from '../utils/id';
import { continuationEvents } from './devEvents';
import { hasOwnStore } from './devReload';

export interface ChatReplOptions {
  /** Lines to read (a readline interface, any async iterable of lines, or a raw stream, which is split into lines). */
  input: AsyncIterable<string> | Readable;
  output: Writable;
  /** Where errors go; defaults to `output`. */
  errorOutput?: Writable;
  /** Builds the agent; `/model <spec>` calls it again with the new model (the old agent is closed once the new one is built). */
  createAgent: (model?: string) => Promise<SimpleAgent>;
  /** Where sessions live unless the agent has a `store` of its own. Default: `memoryStore()`. */
  store?: Required<AgentStore>;
  /** The model the agent was built with, shown in the banner. */
  model?: string;
  /** Session to open; default a new one. */
  sessionId?: string;
  /** Dim tool lines with ANSI codes. */
  color?: boolean;
  /** Shows the prompt before a line is read; default writes it to `output`. A readline wiring sets it so line editing keeps the prompt. */
  writePrompt?: (text: string) => void;
}

const QUIET_FINISH: ReadonlySet<string> = new Set(['stop', 'awaiting-approval', 'error', 'tool_calls']);
const COMMANDS = '/new, /compact, /clear, /model <provider/model>, /history, /quit';

function clip(text: string, max = 160): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function show(value: unknown): string {
  return clip(typeof value === 'string' ? value : (JSON.stringify(value) ?? 'undefined'));
}

function describeError(error: unknown): string {
  return `error: ${error instanceof Error ? error.message : String(error)}`;
}

function usageLine({ inputTokens, outputTokens, estimated, costUsd }: AgentEventUsage): string {
  const cost = costUsd === undefined ? '' : `, $${costUsd.toFixed(4)}`;
  return `[usage] ${estimated ? '~' : ''}${inputTokens} in / ${outputTokens} out tokens${cost}`;
}

/** Runs the REPL until `/quit` or the end of the input; resolves to the exit code (0). */
export async function runChatRepl(options: ChatReplOptions): Promise<number> {
  const { output, errorOutput = output, createAgent, store = memoryStore(), color = false } = options;
  const lines = (typeof (options.input as Readable).pipe === 'function' ? readline.createInterface({ input: options.input as Readable }) : options.input)[
    Symbol.asyncIterator
  ]() as AsyncIterator<string>;
  const writePrompt = options.writePrompt ?? ((text: string) => void output.write(text));
  const dim = (text: string) => (color ? `\x1b[2m${text}\x1b[22m` : text);
  const say = (text: string) => void output.write(`${text}\n`);
  const fail = (error: unknown) => void errorOutput.write(`${describeError(error)}\n`);
  const ask = async (prompt: string): Promise<string | undefined> => {
    writePrompt(prompt);
    const next = await lines.next();
    return next.done ? undefined : next.value.trim();
  };

  let agent = await createAgent(options.model);
  let model = options.model;
  let sessionId = options.sessionId ?? `chat-${newId().slice(0, 8)}`;
  assertSessionId(sessionId);
  const openSession = (): AgentSession => agent.session(hasOwnStore(agent) ? { id: sessionId } : { id: sessionId, store });

  let lineOpen = false;
  const endLine = () => {
    if (lineOpen) say('');
    lineOpen = false;
  };

  type Printers = { [K in AgentEventType]?: (event: AgentEventOf<K>) => void };
  const printers: Printers = {
    'text.delta': (event) => {
      if (event.subagent) return;
      output.write(event.text);
      lineOpen = event.text !== '' && !event.text.endsWith('\n');
    },
    'text.done': endLine,
    'tool.start': (event) => {
      endLine();
      say(dim(`[${event.toolName}] ${show(event.args)}`));
    },
    'tool.done': (event) => say(dim(`  -> ${show(event.result)}`)),
    'tool.error': (event) => say(dim(`  -> error: ${event.error.message}`)),
    error: (event) => {
      endLine();
      errorOutput.write(`error: ${event.error.message}\n`);
    },
    'run.done': (event) => {
      endLine();
      if (event.usage) say(dim(usageLine(event.usage)));
      if (!QUIET_FINISH.has(event.finishReason)) say(dim(`[finished: ${event.finishReason}]`));
    },
  };

  /** Prints a turn's events; resolves to the approval it paused on, if any. */
  async function render(events: AsyncIterable<AgentEvent> | AgentEvent[]): Promise<AgentEventOf<'approval.requested'> | undefined> {
    let paused: AgentEventOf<'approval.requested'> | undefined;
    for await (const event of events) {
      (printers[event.type] as ((event: AgentEvent) => void) | undefined)?.(event);
      if (event.type === 'approval.requested') paused = event;
    }
    return paused;
  }

  /** Shows a question and reads the answer (an option's number or free text); `undefined` when the input ends. */
  async function readAnswer({ text, options: choices = [], allowFreeText }: ApprovalQuestion): Promise<string | undefined> {
    say(`? ${text}`);
    choices.forEach((choice, i) => say(`  ${i + 1}) ${choice}`));
    for (let reply = await ask(choices.length ? 'Answer (number or text): ' : 'Answer: '); reply !== undefined; reply = await ask('Answer: ')) {
      const chosen = choices[Number(reply) - 1];
      if (chosen !== undefined) return chosen;
      if (reply !== '' && (allowFreeText !== false || choices.length === 0 || choices.includes(reply))) return reply;
      say(`Pick a number from 1 to ${choices.length}.`);
    }
    return undefined;
  }

  /** Asks the user about `request` and continues the turn; resolves to the continued turn's events. */
  async function decide(request: PendingApproval): Promise<AgentEvent[]> {
    const { id } = request;
    let result;
    if (request.kind === 'question' && request.question) {
      const answer = await readAnswer(request.question);
      result = answer === undefined ? await agent.approvals.resolve({ id, approved: false }) : await agent.approvals.answer({ id, answer });
    } else {
      const reply = await ask(`Approve ${request.toolName}(${show(request.args)})? [y/N] `);
      result = await agent.approvals.resolve({ id, approved: /^y(es)?$/i.test(reply ?? '') });
    }
    const pausedAgain = (await agent.approvals.list()).find((pending) => pending.id === result.approvalId);
    return continuationEvents(result, request, pausedAgain);
  }

  async function turn(input: string): Promise<void> {
    try {
      let events: AsyncIterable<AgentEvent> | AgentEvent[] = openSession().stream(input);
      for (let paused = await render(events); paused; paused = await render(events)) {
        const request = (await agent.approvals.list()).find((pending) => pending.id === paused?.approvalId);
        if (!request) throw new Error(`No pending approval '${paused.approvalId}'.`);
        events = await decide(request);
      }
    } catch (error) {
      endLine();
      fail(error);
    }
  }

  function transcriptLine(message: Message): string[] {
    const text = textOf(message);
    if (message.role === 'tool') return [dim(`  -> ${show(text)}`)];
    const calls = (message.toolCalls ?? []).map((call) => dim(`[${call.function.name}] ${clip(call.function.arguments)}`));
    return [...(text ? [`${message.role === 'user' ? 'you' : message.role}: ${text}`] : []), ...calls];
  }

  async function command(line: string): Promise<boolean> {
    const [name, ...rest] = line.split(/\s+/);
    if (name === '/quit' || name === '/exit') return false;
    if (name === '/new') {
      sessionId = `chat-${newId().slice(0, 8)}`;
      say(`New session ${sessionId}.`);
    } else if (name === '/history') {
      const messages = await openSession().load();
      if (messages.length === 0) say('(no messages yet)');
      messages.flatMap(transcriptLine).forEach(say);
    } else if (name === '/compact' || name === '/clear') {
      try {
        const session = openSession();
        if (name === '/clear') {
          await session.clear();
          say('Conversation cleared.');
        } else {
          const { tokensBefore, tokensAfter, messagesBefore, messagesAfter } = await session.compact();
          say(`Compacted: ${messagesBefore} -> ${messagesAfter} messages, ~${tokensBefore} -> ~${tokensAfter} tokens.`);
        }
      } catch (error) {
        fail(error);
      }
    } else if (name === '/model' && rest.length === 1) {
      try {
        const next = await createAgent(rest[0]);
        await agent.close().catch(() => undefined);
        [agent, model] = [next, rest[0]];
        say(`Model is now ${model}.`);
      } catch (error) {
        fail(error);
      }
    } else say(`Unknown command '${line}'. Commands: ${COMMANDS}`);
    return true;
  }

  say(dim(`loushy chat: session ${sessionId}${model ? `, model ${model}` : ''}. Commands: ${COMMANDS}`));
  try {
    for (let line = await ask('> '); line !== undefined; line = await ask('> ')) {
      if (line === '') continue;
      if (!line.startsWith('/')) await turn(line);
      else if (!(await command(line))) break;
    }
  } finally {
    await agent.close().catch(() => undefined);
  }
  return 0;
}
