import { describe, it, expect, vi } from 'vitest';
import { AgentExecutor } from './AgentExecutor';
import { ToolRegistry } from '../tools';
import { AgentBuilder } from '../core';
import { SandboxAdapter } from '../security/sandbox';
import { mockModel } from '../testing';

/** A model that emits exactly one tool call (for `toolName`) and then stops. */
function makeSingleToolCallProvider(toolName: string) {
  return mockModel([{ toolCalls: [{ name: toolName }] }, 'done']);
}

describe('AgentExecutor sandbox wiring (LOU-F5 / LOU-F fix)', () => {
  it("routes a requiresSandbox:true tool with sandboxExecute() through the configured SandboxAdapter, never touching tool.execute()", async () => {
    const toolExecute = vi.fn().mockResolvedValue({ done: true });
    const toolRegistry = new ToolRegistry();

    // A genuine sandboxExecute implementation: it does the tool's real
    // work itself via sandbox.writeFile()/sandbox.run() - e.g. writing the
    // args to a file and running a command that operates on them - rather
    // than a disconnected dummy command.
    const sandboxExecute = vi.fn(async (args: unknown, sandbox: SandboxAdapter) => {
      await sandbox.writeFile('sandboxed-args.json', JSON.stringify(args));
      const runResult = await sandbox.run('echo', ['hello-from-real-work']);
      return { stdout: runResult.stdout };
    });

    toolRegistry.register('sandboxed', {
      displayName: 'Sandboxed tool',
      tool: { description: 'sandboxed', parameters: {}, execute: toolExecute } as any,
      requiresSandbox: true,
      sandboxExecute,
    });

    const agent = AgentBuilder.create()
      .setName('Test Agent')
      .addTool('sandboxed', { tool: 'sandboxed', options: {} })
      .build();

    const spySandbox: SandboxAdapter = {
      name: 'spy',
      run: vi.fn().mockResolvedValue({ stdout: 'hello-from-real-work', stderr: '', exitCode: 0 }),
      writeFile: vi.fn().mockResolvedValue(undefined),
    };

    const onToolResult = vi.fn();

    const result = await AgentExecutor.execute({
      agent,
      input: 'go',
      provider: makeSingleToolCallProvider('sandboxed'),
      toolRegistry,
      sandbox: spySandbox,
      onToolResult,
    });

    // sandboxExecute() itself was invoked, with the real args and the
    // configured sandbox adapter.
    expect(sandboxExecute).toHaveBeenCalledTimes(1);
    expect(sandboxExecute).toHaveBeenCalledWith({}, spySandbox);

    // The sandbox adapter's run()/writeFile() were called with parameters
    // that actually relate to the tool's real work (not a disconnected
    // version-check command).
    expect(spySandbox.writeFile).toHaveBeenCalledWith(
      'sandboxed-args.json',
      JSON.stringify({})
    );
    expect(spySandbox.run).toHaveBeenCalledWith('echo', ['hello-from-real-work']);

    // Critical assertion: the tool's own in-process execute() is NEVER
    // called for a genuinely-sandboxed tool.
    expect(toolExecute).not.toHaveBeenCalled();

    expect(result.finishReason).toBe('stop');
    expect(onToolResult).toHaveBeenCalledTimes(1);
    const [, toolResultArg] = onToolResult.mock.calls[0];
    expect(toolResultArg?.error).toBeUndefined();
    expect(toolResultArg?.result).toEqual({ stdout: 'hello-from-real-work' });
  });

  it('a requiresSandbox:true tool with NO sandboxExecute() fails closed - it throws instead of silently running in-process', async () => {
    const toolExecute = vi.fn().mockResolvedValue({ done: true });
    const toolRegistry = new ToolRegistry();
    toolRegistry.register('unsandboxable', {
      displayName: 'Unsandboxable tool',
      tool: { description: 'unsandboxable', parameters: {}, execute: toolExecute } as any,
      requiresSandbox: true,
      // no sandboxExecute implementation - this is the bug scenario
    });

    const agent = AgentBuilder.create()
      .setName('Test Agent')
      .addTool('unsandboxable', { tool: 'unsandboxable', options: {} })
      .build();

    const spySandbox: SandboxAdapter = {
      name: 'spy',
      run: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
      writeFile: vi.fn().mockResolvedValue(undefined),
    };

    const onToolResult = vi.fn();

    const result = await AgentExecutor.execute({
      agent,
      input: 'go',
      provider: makeSingleToolCallProvider('unsandboxable'),
      toolRegistry,
      sandbox: spySandbox,
      onToolResult,
    });

    // Fail-closed: neither the tool's real execute() NOR any real sandbox
    // operation happens. Before this fix, tool.execute() would have run
    // in-process on the host unconditionally, and sandbox.run() would have
    // fired an unrelated dummy command - both silently, while the caller
    // believed the tool was isolated.
    expect(toolExecute).not.toHaveBeenCalled();
    expect(spySandbox.run).not.toHaveBeenCalled();
    expect(spySandbox.writeFile).not.toHaveBeenCalled();

    // The clear, descriptive error surfaces as a conversational tool
    // result (the established fail-closed / error-surfacing pattern in
    // this codebase - see the 'failingTool' test above), not a silent
    // unsandboxed execution.
    expect(onToolResult).toHaveBeenCalledTimes(1);
    const [, toolResultArg] = onToolResult.mock.calls[0];
    expect(toolResultArg?.error).toContain('unsandboxable');
    expect(toolResultArg?.error).toContain('requiresSandbox');
    expect(toolResultArg?.error).toContain('sandboxExecute');
    expect(toolResultArg?.error).toContain('refusing to fall back to unsandboxed execution');

    expect(result.finishReason).toBe('stop');
  });

  it('a tool WITHOUT requiresSandbox never touches the sandbox adapter (unchanged prior path)', async () => {
    const toolExecute = vi.fn().mockResolvedValue({ done: true });
    const toolRegistry = new ToolRegistry();
    toolRegistry.register('plain', {
      displayName: 'Plain tool',
      tool: { description: 'plain', parameters: {}, execute: toolExecute } as any,
      // no requiresSandbox
    });

    const agent = AgentBuilder.create()
      .setName('Test Agent')
      .addTool('plain', { tool: 'plain', options: {} })
      .build();

    const spySandbox: SandboxAdapter = {
      name: 'spy',
      run: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
      writeFile: vi.fn().mockResolvedValue(undefined),
    };

    await AgentExecutor.execute({
      agent,
      input: 'go',
      provider: makeSingleToolCallProvider('plain'),
      toolRegistry,
      sandbox: spySandbox,
    });

    expect(spySandbox.run).not.toHaveBeenCalled();
    expect(spySandbox.writeFile).not.toHaveBeenCalled();
    expect(toolExecute).toHaveBeenCalled();
  });

  it('NoopSandbox with a tool that DOES implement sandboxExecute() still routes through the real adapter', async () => {
    const toolExecute = vi.fn().mockResolvedValue({ done: true });
    const toolRegistry = new ToolRegistry();

    const sandboxExecute = vi.fn(async (_args: unknown, sandbox: SandboxAdapter) => {
      const runResult = await sandbox.run(
        process.execPath,
        ['-e', 'process.stdout.write("noop-ran")']
      );
      return { stdout: runResult.stdout.trim() };
    });

    toolRegistry.register('sandboxed-noop', {
      displayName: 'Sandboxed tool (Noop)',
      tool: { description: 'sandboxed', parameters: {}, execute: toolExecute } as any,
      requiresSandbox: true,
      sandboxExecute,
    });

    const agent = AgentBuilder.create()
      .setName('Test Agent')
      .addTool('sandboxed-noop', { tool: 'sandboxed-noop', options: {} })
      .build();

    // No `sandbox` option passed - AgentExecutor defaults to NoopSandbox.
    const result = await AgentExecutor.execute({
      agent,
      input: 'go',
      provider: makeSingleToolCallProvider('sandboxed-noop'),
      toolRegistry,
    });

    expect(sandboxExecute).toHaveBeenCalledTimes(1);
    expect(toolExecute).not.toHaveBeenCalled();
    expect(result.finishReason).toBe('stop');
  });
});
