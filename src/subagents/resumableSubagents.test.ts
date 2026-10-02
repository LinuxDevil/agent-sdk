/** LOU-Y6: the `task` tool continues a sub-agent by taskId (resume), branches it (fork), or starts a new one. */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { mockModel, type MockTurn } from '../testing';
import { memoryStore } from '../storage/agentStore';
import { SqliteStore } from '../storage/sqlite';
import type { Message } from '../providers';

type TaskCallArgs = { agent?: string; prompt: string; taskId?: string; mode?: string; background?: boolean };
const task = ({ agent = 'researcher', ...rest }: TaskCallArgs): MockTurn => ({
  toolCalls: [{ name: 'task', args: { agent, description: 'a task', ...rest } }],
});

/** The `task` results the lead saw, in order: the text, or the error message. */
function taskResults(messages: readonly Message[]): string[] {
  return messages
    .filter((m) => m.role === 'tool' && m.toolName === 'task')
    .map((m) => {
      const parsed = JSON.parse(m.content as string) as string | { message?: string; taskId?: string };
      return typeof parsed === 'string' ? parsed : (parsed.message ?? JSON.stringify(parsed));
    });
}

/** What the child model was asked, per call, without its system prompt. */
const childTurns = (model: ReturnType<typeof mockModel>) =>
  model.calls.map((call) => call.messages.filter((m) => m.role !== 'system').map((m) => `${m.role}: ${String(m.content)}`));

function researcher(turns: MockTurn[]) {
  const model = mockModel(turns);
  return { model, agent: createAgent({ provider: model, instructions: 'You research.', description: 'Researches' }) };
}

describe('resumable sub-agent tasks (LOU-Y6)', () => {
  it('resume continues the child with its transcript and the new prompt as the next user turn', async () => {
    const child = researcher(['Paris.', 'About 2.1 million.']);
    const lead = createAgent({
      provider: mockModel([task({ prompt: 'Capital of France?' }), task({ prompt: 'Its population?', taskId: 'task_1' }), 'done']),
      subagents: { researcher: child.agent },
    });

    const result = await lead.send('go');

    expect(childTurns(child.model)[1]).toEqual([
      'user: Capital of France?',
      'assistant: Paris.',
      'user: Its population?',
    ]);
    const [first, second] = taskResults(result.messages);
    expect(first).toContain("taskId 'task_1'");
    expect(second).toBe("About 2.1 million.\n\n[sub-agent 'researcher': 1 step(s), finish reason 'stop', taskId 'task_1']");
  });

  it('fork starts a new task from a copy; the original is left untouched', async () => {
    const child = researcher(['A1', 'B1', 'A2']);
    const lead = createAgent({
      provider: mockModel([
        task({ prompt: 'A' }),
        task({ prompt: 'B', taskId: 'task_1', mode: 'fork' }),
        task({ prompt: 'C', taskId: 'task_1' }),
        'done',
      ]),
      subagents: { researcher: child.agent },
    });

    const result = await lead.send('go');

    const turns = childTurns(child.model);
    expect(turns[1]).toEqual(['user: A', 'assistant: A1', 'user: B']);
    expect(turns[2]).toEqual(['user: A', 'assistant: A1', 'user: C']);
    expect(taskResults(result.messages)[1]).toContain("taskId 'task_2'");
  });

  it('an unknown taskId, or one of another sub-agent, is a coded tool error', async () => {
    const child = researcher(['R1']);
    const writer = createAgent({ provider: mockModel(['unused']), description: 'Writes' });
    const lead = createAgent({
      provider: mockModel([
        task({ prompt: 'x', taskId: 'task_9' }),
        task({ prompt: 'A' }),
        task({ agent: 'writer', prompt: 'y', taskId: 'task_1' }),
        task({ prompt: 'z', mode: 'fork' }),
        'done',
      ]),
      subagents: { researcher: child.agent, writer },
    });

    const [unknown, , foreign, noId] = taskResults((await lead.send('go')).messages);

    expect(unknown).toContain("Unknown taskId 'task_9'");
    expect(unknown).toContain('LOUSHO_SUBAGENT_TASK_NOT_FOUND');
    expect(foreign).toContain("belongs to sub-agent 'researcher'");
    expect(foreign).toContain('LOUSHO_SUBAGENT_TASK_NOT_FOUND');
    expect(noId).toContain("mode 'fork' needs the taskId");
  });

  it("tasks are scoped to the lead session: another session cannot resume them", async () => {
    const store = memoryStore();
    const child = researcher(['A1', 'A2']);
    const leadModel = mockModel([task({ prompt: 'A' }), 'ok', task({ prompt: 'again', taskId: 'task_1' }), 'ok', task({ prompt: 'more', taskId: 'task_1' }), 'ok']);
    const lead = createAgent({ provider: leadModel, store, subagents: { researcher: child.agent } });

    await lead.session({ id: 'alpha' }).send('start');
    const other = await lead.session({ id: 'beta' }).send('steal');
    const same = await lead.session({ id: 'alpha' }).send('continue');

    expect(taskResults(other.messages)[0]).toContain('LOUSHO_SUBAGENT_TASK_NOT_FOUND');
    expect(taskResults(same.messages).at(-1)).toContain("A2\n\n[sub-agent 'researcher'");
    expect(childTurns(child.model)[1]).toEqual(['user: A', 'assistant: A1', 'user: more']);
  });

  it('resumes a task through a fresh agent instance on the same SQLite store', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lousho-y6-'));
    const file = join(dir, 'agent.db');
    try {
      const first = new SqliteStore(file);
      const firstChild = researcher(['Paris.']);
      await createAgent({ provider: mockModel([task({ prompt: 'Capital of France?' }), 'ok']), store: first, subagents: { researcher: firstChild.agent } })
        .session({ id: 'chat' })
        .send('start');
      first.close();

      const second = new SqliteStore(file);
      const secondChild = researcher(['About 2.1 million.']);
      const result = await createAgent({
        provider: mockModel([task({ prompt: 'Its population?', taskId: 'task_1' }), 'ok']),
        store: second,
        subagents: { researcher: secondChild.agent },
      })
        .session({ id: 'chat' })
        .send('continue');
      second.close();

      expect(childTurns(secondChild.model)[0]).toEqual(['user: Capital of France?', 'assistant: Paris.', 'user: Its population?']);
      expect(taskResults(result.messages).at(-1)).toContain("taskId 'task_1'");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a background task is busy until it ends, then can be resumed by its id', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const wait = defineTool({ name: 'wait', description: 'Waits', input: z.object({}), execute: async () => (await gate, 'waited') });
    const childModel = mockModel([{ toolCalls: [{ name: 'wait' }] }, 'first', 'second']);
    const child = createAgent({ provider: childModel, tools: [wait], description: 'Researches' });
    const lead = createAgent({
      provider: mockModel([
        task({ prompt: 'A', background: true }),
        task({ prompt: 'too early', taskId: 'task_1' }),
        () => (release(), { toolCalls: [{ name: 'agent_await', args: { taskId: 'task_1' } }] }),
        task({ prompt: 'B', taskId: 'task_1' }),
        'done',
      ]),
      subagents: { researcher: child },
    });

    const result = await lead.send('go');

    const [, busy, resumed] = taskResults(result.messages);
    expect(busy).toContain('LOUSHO_SUBAGENT_TASK_BUSY');
    expect(busy).toContain('agent_await');
    expect(resumed).toContain("second\n\n[sub-agent 'researcher'");
    expect(childTurns(childModel)[2]).toEqual(['user: A', 'assistant: ', 'tool: "waited"', 'assistant: first', 'user: B']);
  });

  it.each([false, true])('an approval inside a resumed child pauses the lead and resumes it (streamed: %s)', async (streamed) => {
    let sent = 0;
    const send = defineTool({ name: 'send', description: 'Sends', input: z.object({}), needsApproval: true, execute: () => (sent++, 'sent!') });
    const childModel = mockModel(['draft ready', { toolCalls: [{ name: 'send' }] }, 'sent it', 'it said sent!']);
    const child = createAgent({ provider: childModel, tools: [send], description: 'Researches' });
    const lead = createAgent({
      provider: mockModel([task({ prompt: 'Draft' }), task({ prompt: 'Send it', taskId: 'task_1' }), task({ prompt: 'What happened?', taskId: 'task_1' }), 'done']),
      store: memoryStore(),
      subagents: { researcher: child },
    });

    const paused = await lead.session({ id: 'chat' }).send('go');
    expect(paused.finishReason).toBe('awaiting-approval');
    expect(childTurns(childModel)[1]).toEqual(['user: Draft', 'assistant: draft ready', 'user: Send it']);

    const decision = { id: paused.approvalId!, approved: true };
    const result = streamed ? await lead.approvals.streamResolve(decision).result : await lead.approvals.resolve(decision);

    expect(sent).toBe(1);
    expect(result.text).toBe('done');
    const results = taskResults(result.messages);
    expect(results[1]).toBe("sent it\n\n[sub-agent 'researcher': 2 step(s), finish reason 'stop', taskId 'task_1']");
    // The third call resumed the transcript saved after the approval.
    expect(childTurns(childModel)[3].slice(-3)).toEqual(['tool: "sent!"', 'assistant: sent it', 'user: What happened?']);
  });
});
