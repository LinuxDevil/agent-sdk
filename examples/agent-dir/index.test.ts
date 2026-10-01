import { describe, it, expect } from 'vitest';
import { loadAgentDir } from '../../src';
import { mockModel } from '../../src/testing';

describe('examples/agent-dir', () => {
  it('loads from disk and its tool and skill are callable offline', async () => {
    const provider = mockModel([
      {
        toolCalls: [
          { name: 'word_count', args: { text: 'one two three' } },
          { name: 'load_skill', args: { name: 'tone' } },
        ],
      },
      'done',
    ]);
    const agent = await loadAgentDir(__dirname, { provider });

    const result = await agent.send('check it');

    expect(result.text).toBe('done');
    const toolOutput = provider.calls[1].messages
      .filter((m) => m.role === 'tool')
      .map((m) => String(m.content))
      .join('\n');
    expect(toolOutput).toContain('"words":3');
    expect(toolOutput).toContain('active voice');
  });
});
