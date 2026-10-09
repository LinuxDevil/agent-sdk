import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { mockModel } from '../testing';
import { equals } from './checks';
import { defineEval } from './defineEval';
import { runTrajectoryCase, type EvalTestContext } from './trajectory';
import type { EvalResult } from './evalResult';

const webSearch = defineTool({ name: 'web_search', description: 'search', input: z.object({ q: z.string() }), execute: () => 'r' });
const deleteRepo = defineTool({ name: 'delete_repo', description: 'delete', input: z.object({}), execute: () => 'gone' });
const summarize = defineTool({ name: 'summarize', description: 'sum', input: z.object({}), execute: () => 's' });

const taskCall = { name: 'task', args: { agent: 'researcher', prompt: 'p', description: 'd' } };

function leadWithResearcher() {
  const researcher = createAgent({
    provider: mockModel([{ toolCalls: [{ name: 'web_search', args: { q: 'bikes' } }] }, { toolCalls: [{ name: 'delete_repo' }] }, { text: 'found' }]),
    instructions: 'r',
    description: 'Researcher',
    tools: [webSearch, deleteRepo],
  });
  return createAgent({
    provider: mockModel([{ toolCalls: [taskCall] }, { toolCalls: [{ name: 'summarize' }] }, { text: 'done' }]),
    instructions: 'lead',
    subagents: { researcher },
    tools: [summarize],
  });
}

function run(test: (t: EvalTestContext) => void | Promise<void>): Promise<EvalResult> {
  return runTrajectoryCase({ name: 'sub', agent: leadWithResearcher(), test }, {}, undefined, undefined);
}

describe('trajectory evals see sub-agent tool calls (Eve MA-F9)', () => {
  it('lists sub-agent calls after the task call that started them, with subagentPath', async () => {
    const result = await run(async (t) => {
      await t.send('go');
    });
    expect(result.toolCalls.map((c) => [c.name, c.subagentPath])).toEqual([
      ['task', undefined],
      ['web_search', ['researcher']],
      ['delete_repo', ['researcher']],
      ['summarize', undefined],
    ]);
  });

  it('calledTool and notCalledTool search the whole tree by default', async () => {
    const result = await run(async (t) => {
      await t.send('go');
      t.calledTool('web_search', { args: { q: 'bikes' }, times: 1 });
      t.notCalledTool('delete_repo');
    });
    expect(result.assertions.map((a) => a.passed)).toEqual([true, false]);
  });

  it('the subagent filter narrows a call to one sub-agent', async () => {
    const result = await run(async (t) => {
      await t.send('go');
      t.calledTool('web_search', { subagent: 'researcher' });
      t.calledTool('summarize', { subagent: 'researcher' });
      t.notCalledTool('summarize', { subagent: 'researcher' });
      t.notCalledTool('web_search', { subagent: 'writer' });
      t.toolOrder(['web_search', 'delete_repo'], { subagent: 'researcher' });
      t.toolOrder(['web_search', 'summarize']);
    });
    expect(result.assertions.map((a) => a.passed)).toEqual([true, false, true, true, true, true]);
  });
});

// Classic form: subagents reach AgentExecutor.execute() and the sub-agent's calls show in the result.
defineEval({
  name: 'classic with subagents',
  agent: { name: 'lead', prompt: 'lead' } as never,
  input: 'go',
  provider: mockModel([{ toolCalls: [taskCall] }, { text: 'done' }]),
  subagents: {
    researcher: createAgent({ provider: mockModel([{ toolCalls: [{ name: 'web_search', args: { q: 'x' } }] }, { text: 'f' }]), instructions: 'r', description: 'R', tools: [webSearch] }),
  },
  score: (result) => (result.text === 'done' ? 1 : 0),
  threshold: 1,
});

const seen: string[] = [];
let attempt = 0;
defineEval({
  name: 'repeat with pass@2',
  agent: () => createAgent({ provider: mockModel([() => (++attempt === 2 ? 'bad' : 'ok')]) }),
  repeat: 3,
  passAt: 2,
  async test(t) {
    await t.send('x');
    seen.push(t.reply);
    t.check('ok reply', t.reply, equals('ok'));
  },
});

describe('defineEval repeat / passAt', () => {
  it('ran the case three times and still passed with one failure', () => {
    expect(seen).toEqual(['ok', 'bad', 'ok']);
  });
});
