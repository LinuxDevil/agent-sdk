import { describe, expect, it } from 'vitest';
import { createAgent } from '../createAgent';
import { mockModel } from '../testing';
import type { Message } from '../providers';
import { withLeadingSystemOnly } from './generateStep';

describe('withLeadingSystemOnly (audit A7)', () => {
  it('returns the messages unchanged when every system message leads', () => {
    const messages: Message[] = [
      { role: 'system', content: 'Prompt.' },
      { role: 'user', content: 'Hi' },
    ];
    expect(withLeadingSystemOnly(messages)).toBe(messages);
  });

  it('appends later system messages, in order, to the leading one and leaves the transcript alone', () => {
    const messages: Message[] = [
      { role: 'system', content: 'Prompt.', metadata: { kept: true } },
      { role: 'user', content: 'Hi' },
      { role: 'system', content: 'Note one.' },
      { role: 'assistant', content: 'Hello' },
      { role: 'system', content: 'Note two.' },
    ];
    expect(withLeadingSystemOnly(messages)).toEqual([
      { role: 'system', content: 'Prompt.\n\nNote one.\n\nNote two.', metadata: { kept: true } },
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello' },
    ]);
    expect(messages).toHaveLength(5);
  });

  it('creates a leading system message when there is none', () => {
    expect(withLeadingSystemOnly([{ role: 'user', content: 'Hi' }, { role: 'system', content: 'Note.', metadata: { handoff: { from: 'a', to: 'b' } } }])).toEqual([
      { role: 'system', content: 'Note.' },
      { role: 'user', content: 'Hi' },
    ]);
  });

  it('applies to every model request, e.g. a history with a caller-supplied system message mid-conversation', async () => {
    const model = mockModel(['OK.']);
    const agent = createAgent({ instructions: 'Prompt.', provider: model });

    const result = await agent.send([
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello' },
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'Explain.' },
    ]);

    expect(result.text).toBe('OK.');
    expect((model.calls[0].messages as Message[]).map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(model.calls[0].messages[0].content).toBe('Prompt.\n\nBe brief.');
  });
});
