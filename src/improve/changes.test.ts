import { describe, expect, it } from 'vitest';
import { changeItems, editorReasons } from './changes';
import type { Harness } from './types';

const BASE: Harness = { instructions: 'You answer questions.\n\nBe brief.', skills: {} };
const skill = (content: string, description = 'When citing.') => ({ description, content });

describe('changeItems', () => {
  it('finds nothing when the harness is unchanged', () => {
    expect(changeItems(BASE, structuredClone(BASE))).toEqual([]);
  });

  it('itemises an added, a modified and a removed instructions line', () => {
    const base: Harness = { instructions: 'You answer questions.\nBe brief.\nUse plain words.', skills: {} };
    const after: Harness = { instructions: 'You answer questions.\nBe brief, one paragraph at most.\nStop when a document is forbidden.', skills: {} };
    expect(changeItems(base, after)).toEqual([
      { kind: 'modify', target: 'instructions', before: 'Be brief.', after: 'Be brief, one paragraph at most.' },
      { kind: 'modify', target: 'instructions', before: 'Use plain words.', after: 'Stop when a document is forbidden.' },
    ]);
    const added: Harness = { instructions: `${base.instructions}\nCite the document.`, skills: {} };
    expect(changeItems(base, added)).toEqual([{ kind: 'add', target: 'instructions', after: 'Cite the document.' }]);
    const removed: Harness = { instructions: 'You answer questions.\nUse plain words.', skills: {} };
    expect(changeItems(base, removed)).toEqual([{ kind: 'remove', target: 'instructions', before: 'Be brief.' }]);
  });

  it('pairs a replaced line as a modify and leaves extra lines as adds', () => {
    const after: Harness = { instructions: 'You answer questions.\n\nBe brief and cite.\nNever guess.', skills: {} };
    expect(changeItems(BASE, after)).toEqual([
      { kind: 'modify', target: 'instructions', before: 'Be brief.', after: 'Be brief and cite.' },
      { kind: 'add', target: 'instructions', after: 'Never guess.' },
    ]);
  });

  it('keeps edits on either side of an unchanged line as separate items', () => {
    const base: Harness = { instructions: 'Start.\nKeep me.\nFinish.', skills: {} };
    const after: Harness = { instructions: 'Begin.\nKeep me.\nEnd.', skills: {} };
    expect(changeItems(base, after)).toEqual([
      { kind: 'modify', target: 'instructions', before: 'Start.', after: 'Begin.' },
      { kind: 'modify', target: 'instructions', before: 'Finish.', after: 'End.' },
    ]);
  });

  it('ignores blank lines and whitespace-only moves', () => {
    const after: Harness = { instructions: 'You answer questions.\nBe brief.\n', skills: {} };
    expect(changeItems(BASE, after)).toEqual([]);
  });

  it('adds and removes whole skill files', () => {
    const base: Harness = { ...BASE, skills: { old: skill('Old way.') } };
    const after: Harness = { ...BASE, skills: { cite: skill('Quote the source.\nName the page.') } };
    expect(changeItems(base, after)).toEqual([
      { kind: 'add', target: 'skill:cite', after: 'description: When citing.\n\nQuote the source.\nName the page.' },
      { kind: 'remove', target: 'skill:old', before: 'description: When citing.\n\nOld way.' },
    ]);
  });

  it('itemises lines inside an edited skill, including its description', () => {
    const base: Harness = { ...BASE, skills: { cite: skill('Quote the source.\nName the page.') } };
    const after: Harness = { ...BASE, skills: { cite: skill('Quote the source exactly.\nName the page.', 'When answering from documents.') } };
    expect(changeItems(base, after)).toEqual([
      { kind: 'modify', target: 'skill:cite', before: 'description: When citing.', after: 'description: When answering from documents.' },
      { kind: 'modify', target: 'skill:cite', before: 'Quote the source.', after: 'Quote the source exactly.' },
    ]);
  });

  it('orders instructions first, then skills by name, whatever the key order', () => {
    const after: Harness = { instructions: `${BASE.instructions}\nNever guess.`, skills: { zeta: skill('Z.'), alpha: skill('A.') } };
    expect(changeItems(BASE, after).map((item) => item.target)).toEqual(['instructions', 'skill:alpha', 'skill:zeta']);
  });

  it('attaches a reason whose quote appears in the changed text', () => {
    const after: Harness = { instructions: 'You answer questions.\n\nBe brief.\nStop when a document is forbidden.', skills: { cite: skill('Quote the source.') } };
    const notes = [
      'kept: stop rule: helped: run stuck/0',
      'reason: instructions: "document is forbidden": run stuck/0 kept reading a forbidden file.',
      'reason: skill:cite: "quote the source": run other/1 gave no source.',
      'reason: skill:other: "Be brief": wrong target, never matches.',
    ].join('\n');
    expect(changeItems(BASE, after, notes)).toEqual([
      { kind: 'add', target: 'instructions', after: 'Stop when a document is forbidden.', reason: 'run stuck/0 kept reading a forbidden file.' },
      { kind: 'add', target: 'skill:cite', after: 'description: When citing.\n\nQuote the source.', reason: 'run other/1 gave no source.' },
    ]);
  });

  it('matches a removed line by its old text, and leaves an unmatched change without a reason', () => {
    const after: Harness = { instructions: 'You answer questions.\nNever guess.', skills: {} };
    const items = changeItems(BASE, after, '- reason: instructions: "Be brief": runs ran long anyway.');
    expect(items).toEqual([{ kind: 'modify', target: 'instructions', before: 'Be brief.', after: 'Never guess.', reason: 'runs ran long anyway.' }]);
    expect(changeItems(BASE, after, 'reason: instructions: "unrelated": nope.')[0]).not.toHaveProperty('reason');
  });
});

describe('reason matching', () => {
  const after: Harness = { instructions: 'You answer questions.\n\nBe brief.\nStop when a document is forbidden.', skills: {} };

  it('ignores a quote too short to pick out a line', () => {
    expect(changeItems(BASE, after, 'reason: instructions: "a": too vague.')[0]).not.toHaveProperty('reason');
  });

  it('prefers the longest matching quote, wherever it appears', () => {
    const notes = 'reason: instructions: "Stop when": general.\nreason: instructions: "a document is forbidden": specific.';
    expect(changeItems(BASE, after, notes)[0].reason).toBe('specific.');
  });

  it('reads capitalised and backticked reason lines', () => {
    expect(changeItems(BASE, after, 'Reason: Instructions: "document is forbidden": capitalised.')[0].reason).toBe('capitalised.');
    expect(changeItems(BASE, after, '`reason: instructions: "document is forbidden": backticked.`')[0].reason).toBe('backticked.');
  });

  it('aligns long instructions that share most lines', () => {
    const lines = Array.from({ length: 3000 }, (_, i) => `Rule ${i}.`);
    const base: Harness = { instructions: lines.join('\n'), skills: {} };
    const edited: Harness = { instructions: [...lines.slice(0, 1500), 'Never guess.', ...lines.slice(1500)].join('\n'), skills: {} };
    expect(changeItems(base, edited)).toEqual([{ kind: 'add', target: 'instructions', after: 'Never guess.' }]);
  });
});

describe('editorReasons', () => {
  it('reads only well-formed reason lines', () => {
    const notes = 'reason: instructions: "a": one\nreason instructions "b" two\nreason: Skill:X-1: "c d": three\nreason: skill:<name>: "e": placeholder\nreason: instructions: "": empty';
    expect(editorReasons(notes)).toEqual([
      { target: 'instructions', quote: 'a', why: 'one' },
      { target: 'skill:x-1', quote: 'c d', why: 'three' },
    ]);
  });
});
