/**
 * Eve MA-F5: a `subagents/<name>/` directory runs through the native sub-agent
 * runtime (`runSubagent()`), whether the lead calls the `task` tool or the
 * backward-compatible `delegate_to_<name>` alias: the lead's deny rules hold
 * in the child, its approvals pause the lead, its usage rolls up, and its
 * events and spans are tagged and nested under the lead's.
 */
import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { loadAgentDir, resolveAgentDir } from './index';
import { mockModel } from '../testing';
import { deny } from '../execution/permissions';
import type { AgentEvent } from '../execution/agentEvents';

const fixture = path.join(__dirname, '__fixtures__', 'dir-subagent-runtime');
const g = globalThis as { __dirSubagentWrites?: string[] };
const usage = (inputTokens: number, outputTokens: number) => ({ inputTokens, outputTokens });

afterEach(() => {
  delete g.__dirSubagentWrites;
});

/** The coder child writes a file (denied by the lead) and then deploys (needs approval). */
function coderScript(delegateCall: { name: string; args: Record<string, unknown> }) {
  return mockModel([
    { toolCalls: [delegateCall], usage: usage(10, 1) }, // lead
    { toolCalls: [{ name: 'write_file', args: { path: 'a.txt' } }], usage: usage(1000, 100) }, // coder
    { toolCalls: [{ name: 'deploy', args: {} }], usage: usage(1000, 100) }, // coder -> pauses
    { text: 'coder done', usage: usage(1, 1) }, // coder, after the approval
    { text: 'lead done', usage: usage(10, 1) }, // lead
  ]);
}

const viaAlias = { name: 'delegate_to_coder', args: { task: 'write a.txt then deploy' } };
const viaTask = { name: 'task', args: { agent: 'coder', prompt: 'write a.txt then deploy', description: 'write and deploy' } };

describe('agent-directory sub-agents run through the native sub-agent runtime (Eve MA-F5)', () => {
  it('lists every createAgent sub-agent directory in the lead config.subagents, keeping the delegate_to_<name> alias', async () => {
    const { config } = await resolveAgentDir(fixture, { provider: mockModel(['x']) });
    expect(Object.keys(config.subagents as Record<string, unknown>).sort()).toEqual(['coder', 'ops']);
    expect((config.tools as unknown as { name: string }[]).map((t) => t.name).sort()).toEqual(['delegate_to_coder', 'delegate_to_ops']);
  });

  for (const [label, call] of [
    ['the delegate_to_<name> alias', viaAlias],
    ['the task tool', viaTask],
  ] as const) {
    it(`via ${label}: inherits the lead's deny rules, pauses the lead for approval, rolls up usage, tags events and nests spans`, async () => {
      const model = coderScript(call);
      const events: AgentEvent[] = [];
      const spans: { name: string; parentId?: string }[] = [];
      const lead = await loadAgentDir(fixture, {
        provider: model,
        permissions: [deny('write_file')],
        onEvent: (event) => void events.push(event),
        exporter: { onSpanStart: () => {}, onSpanEnd: (span) => void spans.push(span) },
      });

      const paused = await lead.send('go');

      // The lead's deny rule holds inside the child.
      expect(g.__dirSubagentWrites ?? []).toEqual([]);
      // The child's approval pauses the lead instead of being dropped.
      expect(paused.finishReason).toBe('awaiting-approval');
      const pending = await lead.approvals.get(paused.approvalId!);
      expect(pending).toMatchObject({ toolName: 'deploy', subagentPath: ['coder'] });
      // The child's tokens roll up into the lead's.
      expect(paused.usage.inputTokens).toBeGreaterThanOrEqual(2010);
      // Events of the child are tagged with it, and its spans nest under the lead's.
      expect(events.some((e) => (e as { subagent?: { name: string } }).subagent?.name === 'coder')).toBe(true);
      expect(spans.filter((s) => !s.parentId)).toHaveLength(1);

      const done = await lead.approvals.resolve({ id: paused.approvalId!, approved: true });
      expect(done.finishReason).toBe('stop');
      expect(done.text).toBe('lead done');
    });
  }

  it('raises maxSubagentDepth to the depth of nested sub-agent directories, so the whole tree can delegate', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'lousho-nested-'));
    try {
      const write = (rel: string, text: string) => {
        mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        writeFileSync(path.join(root, rel), text);
      };
      write('instructions.md', 'You lead.');
      write('subagents/mid/agent.json', '{ "description": "Middle" }');
      write('subagents/mid/instructions.md', 'You are mid.');
      write('subagents/mid/subagents/leaf/agent.json', '{ "description": "Leaf" }');
      write('subagents/mid/subagents/leaf/instructions.md', 'You are leaf.');
      const model = mockModel([
        { toolCalls: [{ name: 'delegate_to_mid', args: { task: 'ask leaf' } }] },
        { toolCalls: [{ name: 'delegate_to_leaf', args: { task: 'answer' } }] },
        'leaf answer',
        'mid answer',
        'lead answer',
      ]);
      const { config } = await resolveAgentDir(root, { provider: model });
      expect(config.maxSubagentDepth).toBe(2);

      const result = await (await loadAgentDir(root, { provider: model })).send('go');
      expect(result.text).toBe('lead answer');
      expect(JSON.stringify(model.calls[3].messages)).toContain('leaf answer');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("lets a sub-agent directory's own approver decide its calls", async () => {
    const model = mockModel([
      { toolCalls: [{ name: 'delegate_to_ops', args: { task: 'restart it' } }] },
      { toolCalls: [{ name: 'restart', args: {} }] },
      'ops done',
      'lead done',
    ]);
    const lead = await loadAgentDir(fixture, { provider: model });

    const result = await lead.send('go');

    expect(result.finishReason).toBe('stop');
    expect(JSON.stringify(model.calls[2].messages)).toContain('restarted');
    expect(JSON.stringify(model.calls[3].messages)).toContain('ops done');
  });
});
