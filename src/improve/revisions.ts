import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync, type Dirent } from 'node:fs';
import path from 'node:path';
import { ConfigurationError, SDKError } from '../execution/errors';
import { harnessRevisionOf } from '../execution/harnessRevision';
import type { Skill } from '../skills/defineSkill';
import { hasFrontmatter, skillFromText, type SkillSource } from '../skills/loadSkills';
import type { Harness } from './types';

/** A saved state of an agent directory's instructions and skills. */
export interface HarnessRevision {
  /** The harness hash, which also names the content file under `.lousho/revisions/`. */
  id: string;
  /** The revision the directory held before this one. */
  parent?: string;
  /** When it was saved, as an ISO timestamp. */
  at: string;
  /** What made it: the first snapshot, an applied proposal, or a rollback. */
  source: 'baseline' | 'apply' | 'rollback';
  /** The saved instructions and skills. */
  harness: Harness;
  /** Skills that are hashed but must never be rewritten or deleted: their folder holds more than `SKILL.md`, their name differs from their folder, or they are a loose `skills/<name>.md` file. */
  readOnly?: string[];
}

type RevisionEvent = Omit<HarnessRevision, 'harness'>;

const REVISIONS = path.join('.lousho', 'revisions');
const LOG = 'log.jsonl';
const MARKDOWN = /\.md$/i;
const JUNK_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);
const SOURCES: readonly string[] = ['baseline', 'apply', 'rollback'];

interface ReadSkill {
  skill: Skill;
  readOnly: boolean;
}

function refuse(message: string, field: string): never {
  throw new ConfigurationError(`readAgentHarness: ${message}`, field);
}

function readText(file: string, field: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch (error) {
    return refuse(`cannot read ${file} (${(error as Error).message}).`, field);
  }
}

function isDirectory(target: string): boolean {
  return statSync(target, { throwIfNoEntry: false })?.isDirectory() ?? false;
}

function isFile(target: string): boolean {
  return statSync(target, { throwIfNoEntry: false })?.isFile() ?? false;
}

function readInstructions(dir: string): string {
  const file = path.join(dir, 'instructions.md');
  if (!isFile(file)) refuse(`${dir} has no instructions.md. Only instructions kept in instructions.md can change; move them out of agent.ts, agent.json or the prompt registry first.`, 'instructions');
  const familyDir = path.join(dir, 'instructions');
  const family = isDirectory(familyDir) ? readdirSync(familyDir).filter((name) => MARKDOWN.test(name)) : [];
  if (family.length > 0) refuse(`${dir} has model-specific instructions (instructions/${family[0]}), which can't be changed safely. Merge them into instructions.md first.`, 'instructions');
  const text = readText(file, 'instructions').trim();
  if (text === '') refuse(`${file} is empty.`, 'instructions');
  return text;
}

function parsed(source: SkillSource, raw: string): Skill {
  try {
    return skillFromText(source, raw);
  } catch (error) {
    if (error instanceof SDKError) refuse(error.message, 'skills');
    throw error;
  }
}

function folderSkill(skillsDir: string, name: string): ReadSkill | undefined {
  const directory = path.join(skillsDir, name);
  const file = path.join(directory, 'SKILL.md');
  if (!isFile(file)) return undefined;
  const skill = parsed({ defaultName: name, file, directory }, readText(file, 'skills'));
  const extra = readdirSync(directory).some((entry) => entry !== 'SKILL.md' && !JUNK_FILES.has(entry) && !(entry.startsWith('.') && entry.endsWith('.lousho-tmp')));
  return { skill, readOnly: extra || skill.name !== name };
}

function looseSkill(skillsDir: string, name: string): ReadSkill | undefined {
  const file = path.join(skillsDir, name);
  const raw = readText(file, 'skills');
  if (!hasFrontmatter(raw)) return undefined;
  return { skill: parsed({ defaultName: name.slice(0, -'.md'.length), file }, raw), readOnly: true };
}

function skillOf(skillsDir: string, entry: Dirent): ReadSkill | undefined {
  if (entry.isDirectory()) return folderSkill(skillsDir, entry.name);
  return entry.isFile() && MARKDOWN.test(entry.name) ? looseSkill(skillsDir, entry.name) : undefined;
}

function readSkills(dir: string): ReadSkill[] {
  const skillsDir = path.join(dir, 'skills');
  if (!isDirectory(skillsDir)) return [];
  const found = readdirSync(skillsDir, { withFileTypes: true }).flatMap((entry) => skillOf(skillsDir, entry) ?? []);
  const seen = new Set<string>();
  for (const { skill } of found) {
    if (seen.has(skill.name)) refuse(`two skills in ${skillsDir} are named '${skill.name}'.`, 'skills');
    seen.add(skill.name);
  }
  return found;
}

export function readHarnessState(dir: string): { harness: Harness; readOnly: string[] } {
  const instructions = readInstructions(dir);
  const found = readSkills(dir);
  const skills = Object.fromEntries(found.map(({ skill }) => [skill.name, { description: skill.description, content: skill.content }]));
  const readOnly = found.filter((entry) => entry.readOnly).map((entry) => entry.skill.name).sort();
  return { harness: { instructions, skills }, readOnly };
}

/** sha256 of the instructions and the skills sorted by name, the same for equal harnesses. */
export function harnessHash(harness: Harness): string {
  return harnessRevisionOf(harness.instructions, Object.entries(harness.skills).map(([name, skill]) => ({ name, ...skill })));
}

/** Reads instructions.md and skills/<name>/SKILL.md from an agent directory. Throws when instructions come from elsewhere. */
export function readAgentHarness(dir: string): Harness {
  return readHarnessState(dir).harness;
}

function isHarness(value: unknown): value is Harness {
  const harness = value as Harness | undefined;
  if (typeof harness?.instructions !== 'string' || typeof harness.skills !== 'object' || harness.skills === null) return false;
  return Object.values(harness.skills).every((skill) => typeof skill?.description === 'string' && typeof skill.content === 'string');
}

function savedHarness(folder: string, id: string): Harness | undefined {
  try {
    const saved = (JSON.parse(readFileSync(path.join(folder, `${id}.json`), 'utf8')) as { harness?: unknown }).harness;
    if (!isHarness(saved)) return undefined;
    const skills = Object.fromEntries(Object.entries(saved.skills).map(([name, skill]) => [name, { description: skill.description, content: skill.content }]));
    const harness: Harness = { instructions: saved.instructions, skills };
    return harnessHash(harness) === id ? harness : undefined;
  } catch {
    return undefined;
  }
}

function isEvent(value: unknown): value is RevisionEvent {
  const event = value as RevisionEvent | undefined;
  return typeof event?.id === 'string' && /^[0-9a-f]{64}$/.test(event.id) && typeof event.at === 'string' && SOURCES.includes(event.source);
}

function readEvents(folder: string): RevisionEvent[] {
  const file = path.join(folder, LOG);
  if (!isFile(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .flatMap((line) => {
      try {
        const event: unknown = JSON.parse(line);
        return isEvent(event) ? [event] : [];
      } catch {
        return [];
      }
    });
}

function saveHarness(folder: string, id: string, harness: Harness): void {
  if (savedHarness(folder, id)) return;
  const file = path.join(folder, `${id}.json`);
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ id, harness }, null, 2)}\n`);
  renameSync(temp, file);
}

const sameList = (a: readonly string[] = [], b: readonly string[] = []): boolean => a.length === b.length && a.every((name, i) => name === b[i]);

/** Saves the directory's current harness as a revision; does nothing when that revision is already the newest. */
export function snapshotRevision(dir: string, source: HarnessRevision['source'], parent?: string): HarnessRevision {
  const { harness, readOnly } = readHarnessState(dir);
  const id = harnessHash(harness);
  const folder = path.join(dir, REVISIONS);
  const latest = readEvents(folder).at(-1);
  if (latest?.id === id && sameList(latest.readOnly, readOnly) && savedHarness(folder, id)) return { ...latest, harness };
  mkdirSync(folder, { recursive: true });
  saveHarness(folder, id, harness);
  const event: RevisionEvent = { id, ...(parent ? { parent } : {}), at: new Date().toISOString(), source, ...(readOnly.length > 0 ? { readOnly } : {}) };
  appendLine(path.join(folder, LOG), JSON.stringify(event));
  return { ...event, harness };
}

function appendLine(file: string, line: string): void {
  const text = isFile(file) ? readFileSync(file, 'utf8') : '';
  appendFileSync(file, `${text === '' || text.endsWith('\n') ? '' : '\n'}${line}\n`);
}

/** The id of the directory's current harness. */
export function currentRevision(dir: string): string {
  return harnessHash(readAgentHarness(dir));
}

/** Saved revisions, newest first; one whose saved files are missing or don't match its id is left out. */
export function listRevisions(dir: string): HarnessRevision[] {
  const folder = path.join(dir, REVISIONS);
  return readEvents(folder)
    .reverse()
    .flatMap((event) => {
      const harness = savedHarness(folder, event.id);
      return harness ? [{ ...event, harness }] : [];
    });
}
