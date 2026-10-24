import { describe, expect, it } from 'vitest';
import { scrubSecrets } from './scrubSecrets';

describe('scrubSecrets', () => {
  it.each([
    ['OpenRouter', 'sk-or-v1-0123456789abcdef0123456789abcdef'],
    ['OpenAI project', 'sk-proj-Ab3dEf6hIj9kLm2nOp5qRs8t'],
    ['Anthropic', 'sk-ant-api03-Zx9_Yw8-Vu7Ts6Rq5Po4Nm3'],
    ['LangSmith', 'lsv2_pt_0123456789abcdef0123456789abcdef_ab12'],
    ['GitHub classic', 'ghp_0123456789abcdefABCDEF0123456789'],
    ['GitHub fine-grained', 'github_pat_11ABCDEFG0123456789_abcdefghijklmnop'],
    ['AWS access key id', 'AKIAIOSFODNN7EXAMPLE'],
  ])('replaces a %s key with [redacted]', (_name, key) => {
    expect(scrubSecrets(`my key is ${key}, thanks`)).toBe('my key is [redacted], thanks');
  });

  it('keeps the word Bearer and redacts the token after it', () => {
    expect(scrubSecrets('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def')).toBe('Authorization: Bearer [redacted]');
  });

  it('leaves ordinary words and short look-alikes alone', () => {
    const text = 'use sk-learn for the task-runner-0123456789abcdef, a bearer of news, AKIA123, ghp_short';
    expect(scrubSecrets(text)).toBe(text);
  });
});
