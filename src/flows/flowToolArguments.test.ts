/**
 * H3-5: a `toolCall` argument that is exactly one `{{name}}` (or `$name`)
 * passes the variable's value, not its text. H3-7: running a createAgent()
 * agent in a flow (through a tool), and `step` nodes, which do not run.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import type { AgentFlow, EditorStep } from '../types/flow';
import { FlowExecutor } from './FlowExecutor';
import { MockLLMProvider } from '../providers/mock';
import { ToolRegistry } from '../tools';
import { createAgent } from '../createAgent';
import { mockModel } from '../testing';

function flowOf(root: EditorStep): AgentFlow {
  return { code: 'args', name: 'Args', flow: root };
}

function run(root: EditorStep, toolRegistry: ToolRegistry, variables: Record<string, unknown>) {
  return FlowExecutor.execute(flowOf(root), { agent: { name: 'flow-agent' }, provider: new MockLLMProvider({ name: 'mock' }), toolRegistry, variables });
}

describe('toolCall arguments (H3-5)', () => {
  const seen: unknown[] = [];
  const toolRegistry = new ToolRegistry();
  toolRegistry.register('typed', {
    displayName: 'Typed',
    tool: {
      description: 'Takes typed arguments',
      parameters: z.object({ n: z.number(), flag: z.boolean().optional(), tags: z.array(z.string()).optional(), label: z.string().optional() }),
      execute: async (args: unknown) => {
        seen.push(args);
        return 'ok';
      },
    },
  });

  it('passes the raw value of an argument that is exactly one {{name}} or $name', async () => {
    seen.length = 0;
    const result = await run(
      { type: 'toolCall', tool: 'typed', arguments: { n: '{{n}}', flag: '$flag', tags: ['{{tag}}', 'x'] } },
      toolRegistry,
      { n: 5, flag: true, tag: 'a' }
    );
    expect(result.success).toBe(true);
    expect(seen).toEqual([{ n: 5, flag: true, tags: ['a', 'x'] }]);
  });

  it('still interpolates mixed strings as text, and keeps a $ string with no such variable', async () => {
    seen.length = 0;
    const result = await run(
      { type: 'toolCall', tool: 'typed', arguments: { n: '{{n}}', label: 'n is {{n}}, costs $price' } },
      toolRegistry,
      { n: 5 }
    );
    expect(result.success).toBe(true);
    expect(seen).toEqual([{ n: 5, label: 'n is 5, costs $price' }]);

    seen.length = 0;
    await run({ type: 'toolCall', tool: 'typed', arguments: { n: 1, label: '$USD' } }, toolRegistry, {});
    expect(seen).toEqual([{ n: 1, label: '$USD' }]);
  });

  it('a whole {{name}} of an undefined variable is still the empty string', async () => {
    seen.length = 0;
    const result = await run({ type: 'toolCall', tool: 'typed', arguments: { n: 2, label: '{{missing}}' } }, toolRegistry, {});
    expect(result.success).toBe(true);
    expect(seen).toEqual([{ n: 2, label: '' }]);
  });
});

describe('agents in flows (H3-7)', () => {
  it('runs a createAgent() agent through a tool, and its reply is the step output', async () => {
    const researcher = createAgent({ name: 'researcher', provider: mockModel(['Cats sleep 16 hours a day.']), instructions: 'You research.' });
    const toolRegistry = new ToolRegistry();
    toolRegistry.register('research', {
      displayName: 'Research',
      tool: {
        description: 'Asks the researcher agent',
        parameters: z.object({ question: z.string() }),
        execute: async ({ question }: { question: string }) => (await researcher.send(question)).text,
      },
    });
    const result = await run(
      { type: 'toolCall', tool: 'research', arguments: { question: 'About {{topic}}?' }, outputVariable: 'facts' },
      toolRegistry,
      { topic: 'cats' }
    );
    expect(result.success).toBe(true);
    expect(result.variables.facts).toBe('Cats sleep 16 hours a day.');
  });

  it("a 'step' node is not run: the flow fails with LOUSHO_FLOW_INVALID, naming the supported pattern", async () => {
    const result = await run({ type: 'step', agent: 'researcher', input: '{{topic}}' }, new ToolRegistry(), { topic: 'cats' });
    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({ code: 'LOUSHO_FLOW_INVALID' });
    expect(result.error?.message).toContain("'toolCall'");
  });
});
