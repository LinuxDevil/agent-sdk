import { describe, it, expect } from 'vitest';
import { MemoryWorkspace } from '../../src';
import { mockModel } from '../../src/testing';
import { createCodingHarness, fakeExec, FIXTURE, instructionsFor, scriptedExplorer, scriptedLead } from './index';

function memoryWorkspace(): MemoryWorkspace {
  let workspace: MemoryWorkspace;
  workspace = new MemoryWorkspace({ files: FIXTURE, exec: fakeExec(() => workspace) });
  return workspace;
}

function toolOutputs(provider: ReturnType<typeof mockModel>): string {
  const last = provider.calls[provider.calls.length - 1];
  return last.messages.filter((m) => m.role === 'tool').map((m) => String(m.content)).join('\n');
}

describe('examples/coding-harness', () => {
  it('fixes the bug offline, refuses rm, and checkpoints the edit', async () => {
    const workspace = memoryWorkspace();
    const audit: string[] = [];
    const lead = scriptedLead();
    const { agent, checkpoints } = createCodingHarness({
      workspace,
      provider: lead,
      explorerProvider: scriptedExplorer(),
      onAudit: (line) => audit.push(line),
    });

    const session = agent.session();
    const result = await session.send('The test in math.test.js fails. Fix it.');

    expect(result.finishReason).toBe('stop');
    expect(workspace.snapshot()['math.js']).toBe('exports.add = (a, b) => a + b;\n');
    expect(workspace.snapshot()['math.test.js']).toBe(FIXTURE['math.test.js']);
    expect(audit).toContain('shell: deny (Deleting files is not allowed)');
    expect(toolOutputs(lead)).toContain('a - b'); // the explorer's answer reached the lead

    const turns = await checkpoints.list({ sessionId: session.id });
    expect(turns.flatMap((turn) => turn.paths)).toEqual(['math.js']);
    await checkpoints.rewind(0, { sessionId: session.id });
    expect(workspace.snapshot()['math.js']).toBe(FIXTURE['math.js']);
  });

  it('never lets the agent edit a test file', async () => {
    const workspace = memoryWorkspace();
    const { agent } = createCodingHarness({
      workspace,
      provider: mockModel([
        { toolCalls: [{ name: 'write_file', args: { path: 'math.test.js', content: '// gone\n' } }] },
        { text: 'Gave up.' },
      ]),
    });

    await agent.send('Make the tests pass.');

    expect(workspace.snapshot()['math.test.js']).toBe(FIXTURE['math.test.js']);
  });

  it('denies the third identical tool call (loop guard)', async () => {
    const workspace = memoryWorkspace();
    const same = { toolCalls: [{ name: 'read_file', args: { path: 'math.js' } }] };
    const lead = mockModel([same, same, same, { text: 'Stopped.' }]);
    const { agent } = createCodingHarness({ workspace, provider: lead });

    await agent.send('Read math.js three times.');

    expect(toolOutputs(lead)).toContain('You already called read_file with these arguments 2 times');
  });

  it('counts repeats per run, never blocks test runs, and refuses git diff', async () => {
    const workspace = memoryWorkspace();
    const read = { toolCalls: [{ name: 'read_file', args: { path: 'math.js' } }] };
    const test = { toolCalls: [{ name: 'shell', args: { command: 'node --test' } }] };
    const lead = mockModel([
      read, { text: '1' }, read, { text: '2' }, read, { text: '3' },
      test, test, test,
      { toolCalls: [{ name: 'shell', args: { command: 'git diff --output=../x' } }] },
      { text: 'Done.' },
    ]);
    const { agent } = createCodingHarness({ workspace, provider: lead });

    for (const prompt of ['a', 'b', 'c']) await agent.send(prompt);
    await agent.send('Run the tests three times, then diff.');

    expect(toolOutputs(lead)).not.toContain('You already called');
    expect(toolOutputs(lead)).toContain('not on the allow list');
  });

  it('adds a family-specific tail to the instructions', () => {
    expect(instructionsFor('openrouter/openai/gpt-4o-mini')).toContain('one tool at a time');
    expect(instructionsFor('openrouter/anthropic/claude-haiku-4-5')).toContain('Prefer edit_file');
    expect(instructionsFor('ollama/llama3.1')).not.toContain('Prefer edit_file');
  });
});
