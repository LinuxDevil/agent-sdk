import { describe, expect, it } from 'vitest';
import { scrubSecrets } from './scrubSecrets';

// Key-shaped fixtures are built at runtime so no secret-looking literal ships in source.
const stripe = (kind: string) => ['s', 'k_', kind, '_'].join('') + 'x'.repeat(24);
const stripeRestricted = 'r' + 'k_' + 'live' + '_' + 'y'.repeat(24);
const slack = (kind: string) => 'xox' + kind + '-' + '1234567890-abcdefghij';
const google = 'AI' + 'za' + 'S'.repeat(35);
const jwt = ['eyJ' + 'hbGciOiJIUzI1', 'eyJ' + 'zdWIiOiIxMjM0', 'SflKxwRJSMeKKF2QT4fw'].join('.');

describe('scrubSecrets', () => {
  it.each([
    ['Stripe live secret', stripe('live')],
    ['Stripe test secret', stripe('test')],
    ['Stripe restricted', stripeRestricted],
    ['Slack bot', slack('b')],
    ['Slack app', slack('a')],
    ['Slack user', slack('p')],
    ['Slack refresh', slack('r')],
    ['Slack legacy', slack('s')],
    ['Google API key', google],
    ['JWT', jwt],
  ])('replaces a %s key with [redacted]', (_name, key) => {
    expect(scrubSecrets(`value ${key} end`)).toBe('value [redacted] end');
  });

  it('matches Bearer in any case, keeping the word as written', () => {
    const token = 'a'.repeat(24);
    expect(scrubSecrets(`bearer ${token}`)).toBe('bearer [redacted]');
    expect(scrubSecrets(`BEARER ${token}`)).toBe('BEARER [redacted]');
  });

  it('leaves look-alikes of the wider shapes alone', () => {
    const text =
      'skill_level_expert_0123456789, xoxo-hugs, xoxb-short, bearer of news, eyJ, eyJhbGciOiJIUzI1NiJ9, AIza_short, sk_live_short';
    expect(scrubSecrets(text)).toBe(text);
  });

  it.each([
    ['repeated Stripe prefixes', 'sk_live_'.repeat(50_000)],
    ['a long Stripe run', 'sk_live_' + 'a'.repeat(300_000)],
    ['repeated Slack prefixes', 'xoxb-'.repeat(80_000)],
    ['repeated Google prefixes', 'AIza'.repeat(80_000)],
    ['repeated JWT headers', 'eyJabcdefgh.'.repeat(40_000)],
    ['repeated JWT header and payload', 'eyJabcdefgh.eyJabcdefgh'.repeat(20_000)],
    ['repeated case-folded Bearer', 'bEaReR '.repeat(50_000)],
  ])('scrubs %s in linear time', (_name, text) => {
    const start = performance.now();
    scrubSecrets(text);
    expect(performance.now() - start).toBeLessThan(200);
  });

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

  it.each([
    ['repeated sk- prefixes', 'sk-'.repeat(100_000)],
    ['a long digit-free sk- run', `sk-${'a'.repeat(300_000)}`],
    ['repeated gh/lsv2/github_pat prefixes', 'ghp_lsv2_github_pat_'.repeat(20_000)],
    ['repeated Bearer words', 'Bearer '.repeat(50_000)],
    ['repeated AKIA prefixes', 'AKIA'.repeat(80_000)],
  ])('scrubs %s in linear time', (_name, text) => {
    const start = performance.now();
    scrubSecrets(text);
    expect(performance.now() - start).toBeLessThan(100);
  });
});
