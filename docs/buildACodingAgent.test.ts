/**
 * docs/build-a-coding-agent.md: the agent from the page, over a
 * MemoryWorkspace. One test runs it with a scripted model (always offline);
 * the other replays a recording of a real model from
 * docs/__cassettes__/build-a-coding-agent.json. Record it once with
 *   LOUSHO_RECORD=1 OPENROUTER_API_KEY=... npx vitest run docs/buildACodingAgent.test.ts
 * and commit the cassette; until it exists the replay test is skipped.
 */
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  MemoryWorkspace,
  createAgent,
  createFsTools,
  createShellTool,
  resolveProvider,
  type LLMProvider,
} from '../src';
import { mockModel, recordReplay } from '../src/testing';

const CASSETTE = 'docs/__cassettes__/build-a-coding-agent.json';
const DESTRUCTIVE = /\b(rm|mv|chmod|chown|git\s+(push|reset|clean|checkout))\b|>/;

function buildWorkspace(): MemoryWorkspace {
  let runs = 0;
  return new MemoryWorkspace({
    files: {
      'math.js': 'exports.add = (a, b) => a - b;\n',
      'math.test.js':
        "const test = require('node:test');\nconst assert = require('node:assert');\n" +
        "test('add', () => assert.strictEqual(require('./math').add(2, 3), 5));\n",
    },
    // The first test run fails, the later ones pass.
    exec: (command) => {
      if (!/node --test|npm test/.test(command)) return { exitCode: 1, stderr: 'unknown command\n' };
      runs += 1;
      return runs === 1 ? { exitCode: 1, stderr: 'not ok 1 - add\n' } : { stdout: 'ok 1 - add\n' };
    },
  });
}

function buildAgent(workspace: MemoryWorkspace, provider: LLMProvider) {
  return createAgent({
    instructions: 'You are a careful coding agent. Read before you edit; run the tests after every change.',
    provider,
    maxSteps: 12,
    tools: [
      ...createFsTools(workspace, { needsApproval: { write_file: true, edit_file: true } }),
      createShellTool(workspace, { needsApproval: (command) => DESTRUCTIVE.test(command) }),
    ],
  });
}

/** Sends the task and approves every pause, the way the page's loop does. */
async function runTask(agent: ReturnType<typeof buildAgent>, task: string) {
  let pauses = 0;
  let result = await agent.send(task);
  while (result.approvalId) {
    pauses += 1;
    result = await agent.approvals.resolve({ id: result.approvalId, approved: true });
  }
  return { result, pauses };
}

describe('build-a-coding-agent', () => {
  it('fixes the bug: the edit pauses, is approved, and the tests are run', async () => {
    const workspace = buildWorkspace();
    const agent = buildAgent(
      workspace,
      mockModel([
        { toolCalls: [{ name: 'shell', args: { command: 'node --test' } }] },
        { toolCalls: [{ name: 'edit_file', args: { path: 'math.js', old_string: 'a - b', new_string: 'a + b' } }] },
        { toolCalls: [{ name: 'shell', args: { command: 'node --test' } }] },
        'Fixed add(); the tests pass.',
      ]),
    );

    const first = await agent.send('Fix the failing test');
    expect(first.finishReason).toBe('awaiting-approval');
    expect(workspace.snapshot()['math.js']).toContain('a - b');

    const done = await agent.approvals.resolve({ id: first.approvalId!, approved: true });
    expect(done.approvalId).toBeUndefined();
    expect(workspace.snapshot()['math.js']).toContain('a + b');
    expect(workspace.commands.map((c) => c.command)).toEqual(['node --test', 'node --test']);
    expect(done.text).toBe('Fixed add(); the tests pass.');
  });

  it('a rejected edit leaves the file unchanged', async () => {
    const workspace = buildWorkspace();
    const agent = buildAgent(
      workspace,
      mockModel([
        { toolCalls: [{ name: 'edit_file', args: { path: 'math.js', old_string: 'a - b', new_string: 'a + b' } }] },
        'Understood, I will not edit the file.',
      ]),
    );

    const paused = await agent.send('Fix the failing test');
    const done = await agent.approvals.resolve({ id: paused.approvalId!, approved: false, note: 'Not now' });
    expect(workspace.snapshot()['math.js']).toContain('a - b');
    expect(done.text).toBe('Understood, I will not edit the file.');
  });

  // Skipped until the cassette has been recorded (see the header).
  it.skipIf(!existsSync(CASSETTE) && !process.env.LOUSHO_RECORD)(
    'replays a recorded run of a real model',
    async () => {
      const workspace = buildWorkspace();
      const provider = recordReplay(() => resolveProvider('openrouter/openai/gpt-4o-mini'), {
        cassette: CASSETTE,
        mode: process.env.LOUSHO_RECORD ? 'record' : 'replay',
      });
      const agent = buildAgent(workspace, provider);

      const { result, pauses } = await runTask(agent, 'The test in math.test.js fails. Read the files, fix the bug in math.js, and run the tests with node --test.');

      expect(pauses).toBeGreaterThan(0);
      expect(workspace.snapshot()['math.js']).toContain('a + b');
      expect(result.text.length).toBeGreaterThan(0);
    },
    120_000,
  );
});
