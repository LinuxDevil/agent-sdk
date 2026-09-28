import { describe, it, expect } from 'vitest';
import { tokenize } from './tokenizer';

describe('tokenize', () => {
  it('tokenizes a simple if block', () => {
    const tokens = tokenize('{% if x %}hi{% endif %}');
    expect(tokens).toEqual([
      { type: 'open-if', expr: 'x' },
      { type: 'text', value: 'hi' },
      { type: 'close-if' },
    ]);
  });

  it('tokenizes a mixed template with if and for blocks', () => {
    const tokens = tokenize(
      'Users:{% if users %}{% for user in users %}- {{ user.name }}\n{% endfor %}{% else %}none{% endif %}'
    );

    expect(tokens).toEqual([
      { type: 'text', value: 'Users:' },
      { type: 'open-if', expr: 'users' },
      { type: 'open-for', varName: 'user', iterable: 'users' },
      { type: 'text', value: '- ' },
      { type: 'expression', expr: 'user.name' },
      { type: 'text', value: '\n' },
      { type: 'close-for' },
      { type: 'else' },
      { type: 'text', value: 'none' },
      { type: 'close-if' },
    ]);
  });

  it('tokenizes plain text with no tags as a single text token', () => {
    expect(tokenize('just plain text')).toEqual([{ type: 'text', value: 'just plain text' }]);
  });
});
