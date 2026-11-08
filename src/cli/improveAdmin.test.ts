import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyProposal } from '../improve/apply';
import { readAudit } from '../improve/audit';
import { currentRevision, readAgentHarness } from '../improve/revisions';
import type { Harness, ImproveResult } from '../improve/types';
import { runImprove } from './improve';

let dir: string;

function sink() {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  return { stream, text: () => chunks.join('') };
}

async function run(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout = sink();
  const stderr = sink();
  const code = await runImprove(args, { stdout: stdout.stream, stderr: stderr.stream });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

const summary = { runs: 3, excluded: 0, passRate: 0, noise: 0, tokensPerRun: 10 };
const proposal = (harness: Harness): ImproveResult => ({ outcome: 'proposal', reason: 'Gate passed.', harness, base: summary, stages: [], spend: { tokens: 0 } });

async function apply(instructions: string): Promise<{ from: string; to: string }> {
  const base = readAgentHarness(dir);
  return applyProposal(dir, { result: proposal({ ...base, instructions }), base }, { mode: 'auto', by: 'gate' });
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'lousho-improve-admin-'));
  writeFileSync(path.join(dir, 'instructions.md'), 'Be careful.\n');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('lousho improve rollback', () => {
  it('rolls back to the parent of the current revision', async () => {
    const applied = await apply('Changed.');
    const result = await run('rollback', dir, '--by', 'ali', '--reason', 'Worse answers.');
    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(result.stdout).toContain(`${applied.to.slice(0, 12)} -> ${applied.from.slice(0, 12)}`);
    expect(readFileSync(path.join(dir, 'instructions.md'), 'utf8')).toBe('Be careful.\n');
    expect(readAudit(dir).at(-1)).toMatchObject({ action: 'rollback', actor: 'person:ali', reason: 'Worse answers.' });
  });

  it('rollback needs --by on the CLI', async () => {
    await apply('Changed.');
    const result = await run('rollback', dir);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/--by/);
    expect(readFileSync(path.join(dir, 'instructions.md'), 'utf8')).toBe('Changed.\n');
  });

  it('takes --to as a unique id prefix', async () => {
    const first = await apply('First.');
    await apply('Second.');
    const result = await run('rollback', dir, '--to', first.from.slice(0, 8), '--by', 'ali');
    expect(result.code).toBe(0);
    expect(currentRevision(dir)).toBe(first.from);
    expect((await run('rollback', dir, '--to', 'zz', '--by', 'ali')).code).toBe(1);
  });

  it('fails without a revision to go back to', async () => {
    const result = await run('rollback', dir, '--by', 'ali');
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/no earlier revision/);
  });
});

describe('lousho improve rollback defaults', () => {
  it('refuses without --to after a rollback, and after a hand edit', async () => {
    await apply('Changed.');
    expect((await run('rollback', dir, '--by', 'ali')).code).toBe(0);
    const again = await run('rollback', dir, '--by', 'ali');
    expect(again.code).toBe(1);
    expect(again.stderr).toMatch(/came from a rollback/);
    writeFileSync(path.join(dir, 'instructions.md'), 'Edited by hand.\n');
    const edited = await run('rollback', dir, '--by', 'ali');
    expect(edited.stderr).toMatch(/hand edits/);
    expect(readFileSync(path.join(dir, 'instructions.md'), 'utf8')).toBe('Edited by hand.\n');
    expect((await run('revisions', dir)).stdout).toMatch(/unsaved edits/);
  });

  it('needs at least 4 characters of --to', async () => {
    const applied = await apply('Changed.');
    const result = await run('rollback', dir, '--to', applied.from.slice(0, 3), '--by', 'ali');
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/at least 4/);
  });

  it('prints audit fields without terminal control characters', async () => {
    await apply('Changed.');
    const file = path.join(dir, '.lousho', 'audit.jsonl');
    appendFileSync(file, `${JSON.stringify({ seq: 2, at: 'x', actor: 'gate', action: 'apply', reason: 'evil \u001b[31mred' })}\n`);
    const { stdout } = await run('audit', dir);
    expect(stdout).not.toContain('\u001b');
    expect(stdout).toContain('evil  [31mred');
  });
});

describe('lousho improve revisions', () => {
  it('revisions lists newest first, with source and actor', async () => {
    const applied = await apply('Changed.');
    await run('rollback', dir, '--by', 'ali');
    const { code, stdout } = await run('revisions', dir);
    expect(code).toBe(0);
    const lines = stdout.trim().split('\n');
    expect(lines[0]).toMatch(new RegExp(`^\\* ${applied.from.slice(0, 12)} +rollback +person:ali`));
    expect(lines[1]).toMatch(new RegExp(`^  ${applied.to.slice(0, 12)} +apply +gate`));
    expect(lines[2]).toMatch(new RegExp(`^  ${applied.from.slice(0, 12)} +baseline`));
    const json = JSON.parse((await run('revisions', dir, '--json')).stdout) as { id: string; source: string; current: boolean }[];
    expect(json.map((row) => [row.source, row.current])).toEqual([
      ['rollback', true],
      ['apply', false],
      ['baseline', false],
    ]);
  });
});

describe('lousho improve audit', () => {
  it('prints the log oldest first', async () => {
    await apply('Changed.');
    const { code, stdout } = await run('audit', dir);
    expect(code).toBe(0);
    expect(stdout).toMatch(/^1 .* gate apply /);
    const json = JSON.parse((await run('audit', dir, '--json')).stdout) as { action: string }[];
    expect(json.map((entry) => entry.action)).toEqual(['apply']);
  });

  it('audit --verify exits 1 on a broken chain', async () => {
    await apply('Changed.');
    await apply('Changed again.');
    expect(await run('audit', dir, '--verify')).toMatchObject({ code: 0, stdout: expect.stringMatching(/intact/) });
    const file = path.join(dir, '.lousho', 'audit.jsonl');
    const lines = readFileSync(file, 'utf8').split('\n');
    lines[0] = lines[0].replace('"gate"', '"monitor"');
    writeFileSync(file, lines.join('\n'));
    const broken = await run('audit', dir, '--verify');
    expect(broken.code).toBe(1);
    expect(broken.stderr).toMatch(/seq 1/);
  });

  it('reports a truncated last line without throwing', async () => {
    await apply('Changed.');
    mkdirSync(path.join(dir, '.lousho'), { recursive: true });
    appendFileSync(path.join(dir, '.lousho', 'audit.jsonl'), '{"seq":2,');
    expect((await run('audit', dir, '--verify')).code).toBe(1);
  });
});
