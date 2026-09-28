import { describe, it, expect, vi } from 'vitest';
import { AgentExecutor } from './AgentExecutor';
import { ToolRegistry } from '../tools';
import { AgentBuilder } from '../core';
import { AgentType } from '../types';
import { SandboxAdapter } from '../security/sandbox';

/**
 * Builds a scripted provider that emits exactly one tool call (for
 * `toolName`) and then stops - enough to drive AgentExecutor through a
 * single tool execution without depending on MockLLMProvider's
 * content-sniffing heuristics.
 */
function makeSingleToolCallProvider(toolName: string) {
  let call = 0;
  return {
    name: 'scripted',
    supportsTools: () => true,
    supportsStreaming: () => false,
    getModels: async () => ['scripted'],
    stream: async () => {
      throw new Error('not implemented');
    },
    generate: async () => {
      call++;
      if (call === 1) {
        return {
          text: '',
          finishReason: 'tool_calls' as const,
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          toolCalls: [
            {
              id: 'call-1',
              type: 'function' as const,
              function: { name: toolName, arguments: '{}' },
            },
          ],
        };
      }
      return {
        text: 'done',
        finishReason: 'stop' as const,
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      };
    },
  };
}

describe('AgentExecutor sandbox wiring (LOU-F5)', () => {
  it("routes a requiresSandbox:true tool's execution through the configured SandboxAdapter", async () => {
    const toolExecute = vi.fn().mockResolvedValue({ done: true });
    const toolRegistry = new ToolRegistry();
    toolRegistry.register('sandboxed', {
      displayName: 'Sandboxed tool',
      tool: { description: 'sandboxed', parameters: {}, execute: toolExecute } as any,
      requiresSandbox: true,
    });

    const agent = AgentBuilder.create()
      .setType(AgentType.SmartAssistant)
      .setName('Test Agent')
      .addTool('sandboxed', { tool: 'sandboxed', options: {} })
      .build();

    const spySandbox: SandboxAdapter = {
      name: 'spy',
      run: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
      writeFile: vi.fn().mockResolvedValue(undefined),
    };

    const result = await AgentExecutor.execute({
      agent,
      input: 'go',
      provider: makeSingleToolCallProvider('sandboxed') as any,
      toolRegistry,
      sandbox: spySandbox,
    });

    expect(spySandbox.run).toHaveBeenCalled();
    expect(spySandbox.writeFile).toHaveBeenCalled();
    // The tool's own execute logic still ran (its real result surfaces) -
    // this is the documented "route through the adapter, then still
    // invoke the tool's own execute()" bridge (see AgentExecutor's
    // executeToolViaSandbox for the full design rationale).
    expect(toolExecute).toHaveBeenCalled();
    expect(result.finishReason).toBe('stop');
  });

  it('a tool WITHOUT requiresSandbox never touches the sandbox adapter', async () => {
    const toolExecute = vi.fn().mockResolvedValue({ done: true });
    const toolRegistry = new ToolRegistry();
    toolRegistry.register('plain', {
      displayName: 'Plain tool',
      tool: { description: 'plain', parameters: {}, execute: toolExecute } as any,
      // no requiresSandbox
    });

    const agent = AgentBuilder.create()
      .setType(AgentType.SmartAssistant)
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
      provider: makeSingleToolCallProvider('plain') as any,
      toolRegistry,
      sandbox: spySandbox,
    });

    expect(spySandbox.run).not.toHaveBeenCalled();
    expect(spySandbox.writeFile).not.toHaveBeenCalled();
    expect(toolExecute).toHaveBeenCalled();
  });
});
