import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isMap, isScalar, parse as parseYaml, parseDocument } from 'yaml';
import { ConfigurationError } from '../execution/errors';
import type { AuditEntry } from './audit';
import { SKILL_NAME } from './harness';
import { harnessHash, readHarnessState } from './revisions';
import type { Harness } from './types';

/** An agent directory's harness and the skills that must never be rewritten. */
export interface HarnessState {
  /** The instructions and skills. */
  harness: Harness;
  /** Skills that are hashed but never rewritten or deleted. */
  readOnly: string[];
}

/** What a write records so an interrupted one can be finished or undone. */
export interface WriteRecord {
  /** The audit action the write stands for. */
  action: 'apply' | 'rollback';
  /** Who made it. */
  actor: AuditEntry['actor'];
  /** The revision before the write. */
  from: string;
}

/** A finished write: the files it touched, and how to undo it or mark it recorded. */
export interface HarnessWrite {
  /** The files written or removed, relative to the agent directory. */
  written: string[];
  /** The revision the directory now holds. */
  to: string;
  /** Puts the old files back where nobody has changed them since. */
  undo(): void;
  /** Drops the recovery journal once the write is snapshotted and audited. */
  finish(): void;
}

/** What {@link recoverInterruptedWrite} found. */
export interface Recovery {
  /** `undone` put the old files back; `completed` found the write whole and only lacked its records. */
  state: 'undone' | 'completed';
  /** The interrupted write's record. */
  record: WriteRecord & { to: string };
  /** Files it could not put back because they changed after the interruption. */
  kept: string[];
}

interface Step {
  rel: string;
  file: string;
  next?: string;
  prev?: Buffer;
  mode?: number;
  temp?: string;
}

interface JournalFile {
  rel: string;
  prev: string | null;
  next: string | null;
}

interface Journal extends WriteRecord {
  to: string;
  files: JournalFile[];
}

type Skill = Harness['skills'][string];

/** The ConfigurationError field that marks a refusal as stale rather than rejected. */
export const STALE_FIELD = 'base';

const TEMP = '.lousho-tmp';
const JOURNAL = path.join('.lousho', 'apply.pending.json');
const JUNK_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);
const FRONTMATTER = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const SKILL_PATH = /^skills\/([a-z0-9][a-z0-9-]*)\/SKILL\.md$/;

/** A refusal to write, as a ConfigurationError. */
export function refusal(message: string, field = 'proposal'): ConfigurationError {
  return new ConfigurationError(`Refused: ${message}`, field);
}

const sha = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');
const own = (skills: Harness['skills'], name: string): Skill | undefined => (Object.hasOwn(skills, name) ? skills[name] : undefined);

function normal(harness: Harness): Harness {
  const skills = Object.entries(harness.skills).map(([name, skill]) => [name, { description: skill.description.trim(), content: skill.content.trim() }]);
  return { instructions: harness.instructions.trim(), skills: Object.fromEntries(skills) as Harness['skills'] };
}

/** The id a harness gets once written: equal for harnesses that differ only in surrounding whitespace. */
export const writtenHash = (harness: Harness): string => harnessHash(normal(harness));

function sameSkill(a: Skill | undefined, b: Skill | undefined): boolean {
  if (!a || !b) return a === b;
  return a.description.trim() === b.description.trim() && a.content.trim() === b.content.trim();
}

function yamlScalar(value: string): string {
  try {
    if ((parseYaml(`v: ${value}`) as { v?: unknown }).v === value) return value;
  } catch {
    return JSON.stringify(value);
  }
  return JSON.stringify(value);
}

function frontmatterWith(meta: string, description: string): string {
  const doc = parseDocument(meta);
  const pair = isMap(doc.contents) ? doc.contents.items.find((item) => isScalar(item.key) && item.key.value === 'description') : undefined;
  const range = isScalar(pair?.value) ? pair.value.range : undefined;
  if (!range) return `${meta}\ndescription: ${yamlScalar(description)}`;
  return `${meta.slice(0, range[0])}${yamlScalar(description)}${meta.slice(range[1])}`;
}

function skillText(name: string, skill: Skill, prev: Buffer | undefined): string {
  const match = prev === undefined ? null : FRONTMATTER.exec(prev.toString('utf8'));
  const meta = match ? frontmatterWith(match[1], skill.description.trim()) : `name: ${yamlScalar(name)}\ndescription: ${yamlScalar(skill.description.trim())}`;
  return `---\n${meta}\n---\n\n${skill.content.trim()}\n`;
}

function lstat(file: string): fs.Stats | undefined {
  return fs.lstatSync(file, { throwIfNoEntry: false });
}

function guardPath(root: string, rel: string): string {
  let at = root;
  for (const part of rel.split('/')) {
    at = path.join(at, part);
    if (lstat(at)?.isSymbolicLink()) throw refusal(`${rel} goes through a symlink, which could lead outside the agent directory; only real files inside it can change.`);
  }
  const relative = path.relative(root, at);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw refusal(`${rel} resolves outside the agent directory.`);
  return at;
}

const isTemp = (entry: string): boolean => entry.startsWith('.') && entry.endsWith(TEMP);

function guardFolder(root: string, name: string): void {
  const folder = path.join(root, 'skills', name);
  if (!lstat(folder)?.isDirectory()) return;
  const extra = fs.readdirSync(folder).find((entry) => entry !== 'SKILL.md' && !isTemp(entry) && !JUNK_FILES.has(entry));
  if (extra !== undefined) throw refusal(`skills/${name} holds ${extra} as well as SKILL.md, so it is read-only.`);
}

function existing(file: string, rel: string): { prev?: Buffer; mode?: number } {
  const stat = lstat(file);
  if (!stat) return {};
  if (!stat.isFile()) throw refusal(`${rel} is not a regular file, so it can't be replaced.`);
  return { prev: fs.readFileSync(file), mode: stat.mode & 0o777 };
}

function skillStep(root: string, name: string, current: Harness, skill: Skill | undefined): Step {
  if (!SKILL_NAME.test(name)) throw refusal(`'${name}' is not a valid skill name: use lowercase letters, digits and hyphens.`);
  const rel = `skills/${name}/SKILL.md`;
  guardPath(root, `skills/${name}`);
  guardFolder(root, name);
  const file = guardPath(root, rel);
  const { prev, mode } = existing(file, rel);
  if (prev !== undefined && own(current.skills, name) === undefined) throw refusal(`${rel} belongs to another skill, so it can't be written as '${name}'.`);
  return { rel, file, prev, mode, ...(skill && { next: skillText(name, skill, prev) }) };
}

function planWrites(root: string, next: Harness, current: Harness): Step[] {
  const steps: Step[] = [];
  if (next.instructions.trim() !== current.instructions.trim()) {
    const file = guardPath(root, 'instructions.md');
    steps.push({ rel: 'instructions.md', file, ...existing(file, 'instructions.md'), next: `${next.instructions.trim()}\n` });
  }
  const names = [...new Set([...Object.keys(next.skills), ...Object.keys(current.skills)])].sort();
  for (const name of names) {
    const wanted = own(next.skills, name);
    if (!sameSkill(wanted, own(current.skills, name))) steps.push(skillStep(root, name, current, wanted));
  }
  return steps;
}

function guardReadOnly(next: Harness, current: HarnessState): void {
  const touched = current.readOnly.find((name) => !sameSkill(own(next.skills, name), own(current.harness.skills, name)));
  if (touched !== undefined) throw refusal(`skill '${touched}' is read-only (its folder holds more than SKILL.md, or its name differs from its folder), so it can't be changed or removed.`);
}

function durableTemp(file: string, data: Buffer | string, mode = 0o644): string {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}${TEMP}`);
  const fd = fs.openSync(temp, 'wx', mode);
  try {
    fs.writeSync(fd, typeof data === 'string' ? Buffer.from(data) : data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return temp;
}

function makeDirs(folder: string, created: string[]): void {
  const missing: string[] = [];
  for (let at = folder; !fs.existsSync(at); at = path.dirname(at)) missing.unshift(at);
  fs.mkdirSync(folder, { recursive: true });
  created.push(...missing);
}

function contentOf(file: string): Buffer | undefined {
  return lstat(file)?.isFile() ? fs.readFileSync(file) : undefined;
}

function unchangedSince(file: string, expected: Buffer | string | undefined): boolean {
  const now = contentOf(file);
  if (expected === undefined) return now === undefined && !lstat(file);
  return now !== undefined && now.equals(typeof expected === 'string' ? Buffer.from(expected) : expected);
}

function swap(item: Step): void {
  if (!unchangedSince(item.file, item.prev)) throw refusal(`${item.rel} changed while it was being written; the proposal is stale.`, STALE_FIELD);
  if (item.temp) fs.renameSync(item.temp, item.file);
  else fs.rmSync(item.file);
}

function putBack(file: string, prev: Buffer | undefined, mode: number | undefined): void {
  if (prev === undefined) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.renameSync(durableTemp(file, prev, mode), file);
}

function restore(done: readonly Step[]): string[] {
  const kept: string[] = [];
  const failures: unknown[] = [];
  for (const item of [...done].reverse()) {
    try {
      if (unchangedSince(item.file, item.next)) putBack(item.file, item.prev, item.mode);
      else if (!unchangedSince(item.file, item.prev)) kept.push(item.rel);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, `Could not put back ${failures.length} file(s) after a failed write; see .lousho/apply.pending.json.`);
  return kept;
}

function tidy(steps: readonly Step[], created: readonly string[]): void {
  for (const item of steps) if (item.temp) fs.rmSync(item.temp, { force: true });
  for (const folder of [...created].reverse()) {
    try {
      fs.rmdirSync(folder);
    } catch {
      continue;
    }
  }
}

function removeLeftovers(folder: string): void {
  if (!lstat(folder)?.isDirectory()) return;
  for (const entry of fs.readdirSync(folder)) if (isTemp(entry)) fs.rmSync(path.join(folder, entry), { force: true });
}

function sweepTemps(root: string): void {
  removeLeftovers(root);
  const skills = path.join(root, 'skills');
  if (!lstat(skills)?.isDirectory()) return;
  for (const name of fs.readdirSync(skills)) if (lstat(path.join(skills, name))?.isDirectory()) removeLeftovers(path.join(skills, name));
}

function writeJournal(dir: string, journal: Journal): void {
  const file = path.join(dir, JOURNAL);
  fs.renameSync(durableTemp(file, `${JSON.stringify(journal)}\n`), file);
}

function journalOf(steps: readonly Step[], record: WriteRecord, to: string): Journal {
  const files = steps.map((item) => ({ rel: item.rel, prev: item.prev?.toString('base64') ?? null, next: item.next === undefined ? null : sha(item.next) }));
  return { ...record, to, files };
}

function stage(steps: Step[], created: string[]): void {
  for (const item of steps) {
    if (item.next === undefined) continue;
    makeDirs(path.dirname(item.file), created);
    item.temp = durableTemp(item.file, item.next, item.mode);
  }
}

function commit(dir: string, steps: Step[], journal: Journal): void {
  const created: string[] = [];
  const done: Step[] = [];
  try {
    stage(steps, created);
    writeJournal(dir, journal);
    for (const item of steps) {
      done.push(item);
      swap(item);
    }
  } catch (error) {
    try {
      restore(done);
    } catch (failed) {
      throw new AggregateError([error, failed], `${(error as Error).message} Putting the old files back also failed; the next apply will retry from .lousho/apply.pending.json.`);
    }
    fs.rmSync(path.join(dir, JOURNAL), { force: true });
    throw error;
  } finally {
    tidy(steps, created);
  }
}

function readBack(dir: string): Harness | undefined {
  try {
    return readHarnessState(dir).harness;
  } catch {
    return undefined;
  }
}

function emptyFolders(steps: readonly Step[]): string[] {
  return steps.filter((item) => item.next === undefined).map((item) => path.dirname(item.file));
}

function tidyRemoved(steps: readonly Step[]): void {
  for (const folder of emptyFolders(steps)) {
    for (const junk of JUNK_FILES) fs.rmSync(path.join(folder, junk), { force: true });
    try {
      fs.rmdirSync(folder);
    } catch {
      continue;
    }
  }
}

/** Writes a harness over the directory's current one, touching only changed instructions.md and skills/<name>/SKILL.md files; all or nothing, with a journal for crashes. */
export function writeHarnessFiles(dir: string, next: Harness, current: HarnessState, record: WriteRecord): HarnessWrite {
  guardReadOnly(next, current);
  const root = fs.realpathSync(dir);
  sweepTemps(root);
  const steps = planWrites(root, next, current.harness);
  const to = writtenHash(next);
  commit(dir, steps, journalOf(steps, record, to));
  const undo = (): void => {
    restore(steps);
    fs.rmSync(path.join(dir, JOURNAL), { force: true });
  };
  const written = readBack(dir);
  if (!written || writtenHash(written) !== to) {
    undo();
    throw refusal('the written files read back as a different harness, so the old files were put back.');
  }
  const finish = (): void => {
    tidyRemoved(steps);
    fs.rmSync(path.join(dir, JOURNAL), { force: true });
  };
  return { written: steps.map((item) => item.rel).sort(), to, undo, finish };
}

function isJournal(value: unknown): value is Journal {
  const journal = value as Journal | null;
  if (typeof journal?.to !== 'string' || typeof journal.from !== 'string' || !Array.isArray(journal.files)) return false;
  return journal.files.every((file) => file.rel === 'instructions.md' || SKILL_PATH.test(String(file?.rel)));
}

function readJournal(dir: string): Journal | undefined {
  const file = path.join(dir, JOURNAL);
  if (!lstat(file)?.isFile()) return undefined;
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isJournal(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function undoEntry(root: string, entry: JournalFile): string | undefined {
  const file = guardPath(root, entry.rel);
  const now = contentOf(file);
  const prev = entry.prev === null ? undefined : Buffer.from(entry.prev, 'base64');
  const written = entry.next === null ? !lstat(file) : now !== undefined && sha(now) === entry.next;
  if (written) {
    putBack(file, prev, undefined);
    return undefined;
  }
  return unchangedSince(file, prev) ? undefined : entry.rel;
}

/** Finishes or undoes a write that a crash interrupted, from `.lousho/apply.pending.json`; undefined when there is none. Call it holding the apply lock. */
export function recoverInterruptedWrite(dir: string): Recovery | undefined {
  const journal = readJournal(dir);
  if (!journal) {
    fs.rmSync(path.join(dir, JOURNAL), { force: true });
    return undefined;
  }
  const record = { action: journal.action, actor: journal.actor, from: journal.from, to: journal.to };
  const now = readBack(dir);
  if (now && writtenHash(now) === journal.to) {
    fs.rmSync(path.join(dir, JOURNAL), { force: true });
    return { state: 'completed', record, kept: [] };
  }
  const root = fs.realpathSync(dir);
  const kept = journal.files.flatMap((entry) => undoEntry(root, entry) ?? []);
  fs.rmSync(path.join(dir, JOURNAL), { force: true });
  return { state: 'undone', record, kept };
}
