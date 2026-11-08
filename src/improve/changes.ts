import type { Harness, ImproveChange } from './types';

type Op = { kind: 'same' | 'del' | 'ins'; line: string };

interface Reason {
  target: string;
  quote: string;
  why: string;
}

const END: Op = { kind: 'same', line: '' };

const REASON_LINE = /^\s*(?:[-*]\s*)?reason:\s*(instructions|skill:[a-z0-9][a-z0-9-]*)\s*:\s*"([^"]+)"\s*:\s*(.+?)\s*$/;

const linesOf = (text: string) =>
  text
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '');

const skillText = (skill: Harness['skills'][string]) => `description: ${skill.description}\n\n${skill.content}`;

function suffixLengths(a: readonly string[], b: readonly string[]): number[][] {
  const table = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  }
  return table;
}

function align(a: readonly string[], b: readonly string[]): Op[] {
  const table = suffixLengths(a, b);
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      ops.push({ kind: 'same', line: a[i] });
      i += 1;
      j += 1;
    } else if (j >= b.length || (i < a.length && table[i + 1][j] >= table[i][j + 1])) {
      ops.push({ kind: 'del', line: a[i] });
      i += 1;
    } else {
      ops.push({ kind: 'ins', line: b[j] });
      j += 1;
    }
  }
  return ops;
}

function hunkItems(target: string, removed: readonly string[], added: readonly string[]): ImproveChange[] {
  const items: ImproveChange[] = [];
  for (let k = 0; k < Math.max(removed.length, added.length); k += 1) {
    const before = removed[k];
    const after = added[k];
    if (before !== undefined && after !== undefined) items.push({ kind: 'modify', target, before, after });
    else if (before !== undefined) items.push({ kind: 'remove', target, before });
    else items.push({ kind: 'add', target, after });
  }
  return items;
}

function lineItems(target: string, before: string, after: string): ImproveChange[] {
  const items: ImproveChange[] = [];
  let removed: string[] = [];
  let added: string[] = [];
  for (const op of [...align(linesOf(before), linesOf(after)), END]) {
    if (op.kind === 'del') removed.push(op.line);
    else if (op.kind === 'ins') added.push(op.line);
    else {
      items.push(...hunkItems(target, removed, added));
      removed = [];
      added = [];
    }
  }
  return items;
}

function skillItems(name: string, before: Harness['skills'][string] | undefined, after: Harness['skills'][string] | undefined): ImproveChange[] {
  const target = `skill:${name}`;
  if (!before) return after ? [{ kind: 'add', target, after: skillText(after) }] : [];
  if (!after) return [{ kind: 'remove', target, before: skillText(before) }];
  return lineItems(target, skillText(before), skillText(after));
}

export function editorReasons(notes: string): Reason[] {
  return notes.split('\n').flatMap((line) => {
    const match = REASON_LINE.exec(line);
    return match ? [{ target: match[1], quote: match[2].trim(), why: match[3] }] : [];
  });
}

function reasonFor(item: ImproveChange, reasons: readonly Reason[]): string | undefined {
  const text = [item.before, item.after].filter((part) => part !== undefined).join('\n').toLowerCase();
  return reasons.find((reason) => reason.target === item.target && reason.quote !== '' && text.includes(reason.quote.toLowerCase()))?.why;
}

export function changeItems(before: Harness, after: Harness, notes = ''): ImproveChange[] {
  const names = [...new Set([...Object.keys(before.skills), ...Object.keys(after.skills)])].sort();
  const items = [...lineItems('instructions', before.instructions, after.instructions), ...names.flatMap((name) => skillItems(name, before.skills[name], after.skills[name]))];
  const reasons = editorReasons(notes);
  return items.map((item) => {
    const reason = reasonFor(item, reasons);
    return reason === undefined ? item : { ...item, reason };
  });
}
