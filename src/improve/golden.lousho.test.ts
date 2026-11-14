import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyProposal, rollbackHarness } from './apply';
import { listRevisions, readAgentHarness } from './revisions';
import type { ImproveResult } from './types';

let dir: string;

const summary = { runs: 3, excluded: 0, passRate: 0, noise: 0, tokensPerRun: 10 };

function filesUnder(root: string): string[] {
  const found: string[] = [];
  const walk = (at: string, rel: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(path.join(at, entry.name), childRel);
      else if (entry.isFile() && !entry.name.endsWith('.lock')) found.push(childRel);
    }
  };
  walk(root, '');
  return found;
}

afterEach(() => {
  vi.useRealTimers();
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
});

describe('golden .lousho files', () => {
  it('applyProposal and rollbackHarness write the same .lousho files as before the refactor', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'golden-'));
    mkdirSync(path.join(dir, 'skills', 'tone'), { recursive: true });
    writeFileSync(path.join(dir, 'instructions.md'), 'Be brief.\n');
    writeFileSync(path.join(dir, 'skills', 'tone', 'SKILL.md'), '---\nname: tone\ndescription: Tone rules.\n---\n\nUse plain words.\n');
    vi.useFakeTimers({ now: new Date('2026-01-01T00:00:00Z'), toFake: ['Date'] });
    const result: ImproveResult = {
      outcome: 'proposal',
      reason: 'gate ok',
      harness: { instructions: 'Be very brief.', skills: { tone: { description: 'Tone rules.', content: 'Use plain words.' } } },
      base: summary,
      stages: [],
      spend: { tokens: 0 },
    };
    await applyProposal(dir, { result, base: readAgentHarness(dir) }, { mode: 'manual', approvedBy: 'ali' });
    const first = listRevisions(dir).at(-1);
    if (first === undefined) throw new Error('expected a baseline revision');
    await rollbackHarness(dir, first.id, { actor: 'person:ali', reason: 'undo' });
    const rels = [...filesUnder(path.join(dir, '.lousho')).map((rel) => `.lousho/${rel}`), 'instructions.md'].sort();
    const snapshot: Record<string, string> = {};
    for (const rel of rels) snapshot[rel] = readFileSync(path.join(dir, rel), 'utf8');
    expect(snapshot).toMatchSnapshot();
  });
});
