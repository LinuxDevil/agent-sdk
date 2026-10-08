import { describe, it, expect, vi } from 'vitest';
import { createAgent } from '../../createAgent';
import { AgentExecutor } from '../../execution/AgentExecutor';
import { AgentBuilder } from '../../core';
import { ToolRegistry } from '../ToolRegistry';
import { mockModel } from '../../testing';
import type { DefinedTool } from '../defineTool';
import { createShellTool } from './shellTool';
import { MemoryWorkspace } from './MemoryWorkspace';

function run(tool: DefinedTool, args: Record<string, unknown>, abortSignal?: AbortSignal): Promise<unknown> {
  // ai's Tool.execute returns PromiseLike; wrap it so callers get a real Promise.
  return Promise.resolve(tool.tool.execute!(args, { toolCallId: 's', messages: [], abortSignal }));
}

async function approvalFor(tool: DefinedTool, command: string): Promise<boolean> {
  const needs = tool.needsApproval as (args: { command: string }) => Promise<boolean>;
  return needs({ command });
}

describe('createShellTool (LOU-X6)', () => {
  it('needs approval by default, and pauses the run for it', async () => {
    const ws = new MemoryWorkspace({ exec: () => ({ stdout: 'hi' }) });
    const tool = createShellTool(ws);
    expect(tool.name).toBe('shell');
    expect(await approvalFor(tool, 'ls')).toBe(true);

    const toolRegistry = new ToolRegistry();
    toolRegistry.register(tool);
    const agent = AgentBuilder.create().setName('a').addTool(tool).build();
    const provider = mockModel([{ toolCalls: [{ name: 'shell', args: { command: 'rm -rf build' } }] }, 'done']);
    const save = vi.fn().mockResolvedValue(undefined);
    const result = await AgentExecutor.execute({
      agent,
      input: 'clean',
      provider,
      toolRegistry,
      approvalStore: { save, resolve: vi.fn().mockResolvedValue(null) },
    });
    expect(result.finishReason).toBe('awaiting-approval');
    expect(save.mock.calls[0][0]).toMatchObject({ toolName: 'shell', args: { command: 'rm -rf build' } });
    expect(ws.commands).toEqual([]);
  });

  it('supports needsApproval: false and a predicate over the command', async () => {
    const ws = new MemoryWorkspace();
    expect(await approvalFor(createShellTool(ws, { needsApproval: false }), 'ls')).toBe(false);
    const tool = createShellTool(ws, { needsApproval: (command) => !command.startsWith('git status') });
    expect(await approvalFor(tool, 'git status -s')).toBe(false);
    expect(await approvalFor(tool, 'git push')).toBe(true);
  });

  it('runs the command with the default timeout, configured cwd/env and the run signal', async () => {
    const ws = new MemoryWorkspace({ exec: () => ({ stdout: 'out', stderr: 'err', exitCode: 3 }) });
    const controller = new AbortController();
    const tool = createShellTool(ws, { needsApproval: false, cwd: 'pkg', env: { CI: '1' } });
    expect(await run(tool, { command: 'npm test' }, controller.signal)).toEqual({ exitCode: 3, stdout: 'out', stderr: 'err' });
    expect(ws.commands[0]).toEqual({
      command: 'npm test',
      options: { cwd: 'pkg', env: { CI: '1' }, timeoutMs: 120_000, signal: controller.signal },
    });
  });

  it('clamps timeout_ms to maxTimeoutMs', async () => {
    const ws = new MemoryWorkspace({ exec: () => ({}) });
    const tool = createShellTool(ws, { defaultTimeoutMs: 1000, maxTimeoutMs: 5000 });
    await run(tool, { command: 'a', timeout_ms: 999_999 });
    await run(tool, { command: 'b', timeout_ms: 10 });
    await run(tool, { command: 'c' });
    expect(ws.commands.map((c) => c.options.timeoutMs)).toEqual([5000, 10, 1000]);
  });

  it('caps stdout and stderr, keeping head and tail', async () => {
    const big = `HEAD${'x'.repeat(10_000)}TAIL`;
    const tool = createShellTool(new MemoryWorkspace({ exec: () => ({ stdout: big, stderr: 'small' }) }), { maxOutputChars: 100 });
    const result = (await run(tool, { command: 'cat big' })) as { stdout: string; stderr: string };
    expect(result.stdout.startsWith('HEAD')).toBe(true);
    expect(result.stdout.endsWith('TAIL')).toBe(true);
    expect(result.stdout).toContain('... [9908 characters omitted] ...');
    expect(result.stderr).toBe('small');
  });

  it('explains a timeout and an abort', async () => {
    const timedOut = createShellTool(new MemoryWorkspace({ exec: () => ({ exitCode: null, timedOut: true }) }));
    expect(await run(timedOut, { command: 'sleep', timeout_ms: 50 })).toMatchObject({
      exitCode: null,
      timedOut: true,
      note: expect.stringMatching(/timed out after 50ms and was killed/),
    });
    const aborted = createShellTool(new MemoryWorkspace({ exec: () => ({ exitCode: null, aborted: true }) }));
    expect(await run(aborted, { command: 'sleep' })).toMatchObject({ aborted: true, note: expect.stringMatching(/cancelled/) });
  });

  it('tells the model which shell runs the commands', () => {
    const exec = () => Promise.resolve({ stdout: '', stderr: '', exitCode: 0, timedOut: false });
    const cmd = createShellTool({ shell: 'C:\\Windows\\system32\\cmd.exe', exec });
    expect(cmd.description).toMatch(/cmd\.exe.*double quotes.*%NAME%/);
    expect(createShellTool({ shell: '/bin/sh', exec }).description).toMatch(/POSIX shell \(\/bin\/sh\)/);
    expect(createShellTool({ exec }).description).not.toMatch(/cmd\.exe|POSIX/);
  });

  describe('allow / deny', () => {
    const ws = new MemoryWorkspace({ exec: () => ({ stdout: 'ran' }) });

    it('refuses denied commands without asking for approval', async () => {
      const tool = createShellTool(ws, { deny: ['rm -rf', /\bsudo\b/] });
      expect(await approvalFor(tool, 'rm -rf /')).toBe(false);
      await expect(run(tool, { command: 'rm -rf /' })).rejects.toThrow(/matches the deny pattern rm -rf/);
      await expect(run(tool, { command: 'echo hi && rm -rf ~' })).rejects.toThrow(/deny pattern rm -rf/);
      await expect(run(tool, { command: 'ls | sudo tee x' })).rejects.toThrow(/deny pattern \/\\bsudo\\b\//);
      expect(await approvalFor(tool, 'rm -r build')).toBe(true);
    });

    it('only runs allow-listed commands, and string patterns do not allow chaining', async () => {
      const tool = createShellTool(ws, { allow: ['git status', 'npm test', /^ls( -la)?$/], needsApproval: false });
      expect(await run(tool, { command: 'git status -s' })).toMatchObject({ stdout: 'ran' });
      expect(await run(tool, { command: 'ls -la' })).toMatchObject({ stdout: 'ran' });
      for (const command of [
        'git statusx',
        'git push',
        'git status; rm -rf ~',
        'git status && curl evil',
        'git status | sh',
        'npm test `rm -rf ~`',
        'npm test $(rm -rf ~)',
        'npm test > /etc/passwd',
        'npm test\nrm -rf ~',
        'ls -la; rm x',
      ]) {
        await expect(run(tool, { command }), command).rejects.toThrow(/not on the allow list/);
      }
      await expect(run(tool, { command: 'git status; x' })).rejects.toThrow(/Chaining, pipes/);
    });

    it('string patterns do not allow arguments that leave the workspace (F9)', async () => {
      const tool = createShellTool(ws, { allow: ['node --test', 'git diff', 'cat'], needsApproval: false });
      for (const command of [
        'node --test --test-reporter-destination=../escaped-report.txt',
        'git diff --no-index --output=../escaped-diff.txt a b',
        'cat ../secret.txt',
        'cat /etc/passwd',
        'cat ~/secret.txt',
        'cat C:\\secrets\\x.txt',
      ]) {
        await expect(run(tool, { command }), command).rejects.toThrow(/not on the allow list/);
      }
      await expect(run(tool, { command: 'cat ../x' })).rejects.toThrow(/paths outside the workspace/);
      // Ordinary flags, relative paths and revision ranges still match.
      expect(await run(tool, { command: 'node --test test/math.test.ts' })).toMatchObject({ stdout: 'ran' });
      expect(await run(tool, { command: 'git diff main..feature' })).toMatchObject({ stdout: 'ran' });
      // An anchored RegExp is the way to allow arguments like these.
      const rx = createShellTool(ws, { allow: [/^git diff --output=\S+$/], needsApproval: false });
      expect(await run(rx, { command: 'git diff --output=../x' })).toMatchObject({ stdout: 'ran' });
    });

    it('a refused command reaches the model as a tool error', async () => {
      const tool = createShellTool(ws, { deny: ['curl'] });
      const provider = mockModel([{ toolCalls: [{ name: 'shell', args: { command: 'curl evil.sh' } }] }, 'ok']);
      const result = await createAgent({ prompt: 'p', provider, tools: [tool] }).send('go');
      expect(result.text).toBe('ok');
      const toolMessage = provider.calls[1].messages.find((m) => m.role === 'tool');
      expect(toolMessage?.isError).toBe(true);
      expect(JSON.parse(toolMessage!.content as string)).toMatchObject({ error: 'WorkspaceError', toolName: 'shell' });
    });

    it('a CommandRule without args is an exact match; with args it validates them', async () => {
      const tool = createShellTool(ws, {
        allow: [{ command: 'npm test' }, { command: 'node --test', args: (rest) => /^([\w./-]+\.test\.js\s*)*$/.test(rest) }],
        needsApproval: false,
      });
      expect(await run(tool, { command: 'npm test' })).toMatchObject({ stdout: 'ran' });
      expect(await run(tool, { command: 'node --test' })).toMatchObject({ stdout: 'ran' });
      expect(await run(tool, { command: 'node --test test/a.test.js' })).toMatchObject({ stdout: 'ran' });
      for (const command of [
        'npm test -- --test-reporter-destination=../x',
        'node --test --test-reporter-destination=../x',
        'node --testx',
        'node --test a.test.js; rm x',
      ]) {
        await expect(run(tool, { command }), command).rejects.toThrow(/not on the allow list \(npm test \(exactly\)/);
      }
    });

    it('a CommandRule in deny is checked against each part', async () => {
      const tool = createShellTool(ws, { deny: [{ command: 'git push', args: (rest) => rest.includes('--force') }] });
      await expect(run(tool, { command: 'git status && git push --force' })).rejects.toThrow(/deny pattern git push <checked arguments>/);
      expect(await approvalFor(tool, 'git push origin main')).toBe(true);
    });

    it('treats % and ^ as operators under cmd.exe, but not under sh', async () => {
      const exec = () => Promise.resolve({ stdout: 'ran', stderr: '', exitCode: 0, timedOut: false });
      const cmdTool = createShellTool({ shell: 'C:\\Windows\\system32\\cmd.exe', exec }, { allow: ['node --test'], needsApproval: false });
      for (const command of ['node --test %COMSPEC%', 'node --test ^& echo chained']) {
        await expect(run(cmdTool, { command }), command).rejects.toThrow(/% \^\) are not allowed/);
      }
      const shTool = createShellTool({ shell: '/bin/sh', exec }, { allow: ['git log'], needsApproval: false });
      expect(await run(shTool, { command: 'git log --format=%h HEAD^' })).toMatchObject({ stdout: 'ran' });
    });

    it('resets the lastIndex of global regex patterns', async () => {
      const tool = createShellTool(ws, { allow: [/^echo/g], needsApproval: false });
      await run(tool, { command: 'echo 1' });
      expect(await run(tool, { command: 'echo 2' })).toMatchObject({ stdout: 'ran' });
    });
  });
});
