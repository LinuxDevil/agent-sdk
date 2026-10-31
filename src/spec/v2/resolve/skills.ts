/**
 * resolveSkillRef(): builds the `Skill`s one validated `spec.skills` entry
 * stands for — `{ inline }` through `defineSkill`, `{ dir }` through
 * `loadSkills` (a `<dir>/SKILL.md` folder yields that one skill, any other
 * folder every skill it holds) and `{ registry }` the skill `lousho add`
 * installed at `<baseDir>/skills/<name>/`. Node-side, like the rest of
 * `resolve/` — it reads the file system; the schema stays in `../skills.ts`.
 */
import { stat } from 'node:fs/promises';
import * as path from 'node:path';
import { SDKError } from '../../../execution/errors';
import { defineSkill, SKILL_NAME_PATTERN, type Skill } from '../../../skills/defineSkill';
import { loadSkills } from '../../../skills/loadSkills';
import { specFilePath } from '../files';
import type { SkillRef } from '../skills';

/** What resolveSkillRef needs from the host; S16's SpecHost extends it. */
export interface SkillHost {
  /** Absolute directory `dir` refs and installed registry skills resolve against. */
  baseDir: string;
}

/** A `LOUSHO_SKILL_INVALID` failure, prefixed like loadSkills'/defineSkill's own messages. */
function invalid(message: string): never {
  throw new SDKError(`skills: ${message}`, 'LOUSHO_SKILL_INVALID');
}

/** Whether `dir` exists and is a directory; a path that cannot be reached at all counts as missing. */
async function isDirectory(dir: string): Promise<boolean> {
  const stats = await stat(dir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined;
    throw error;
  });
  return stats?.isDirectory() ?? false;
}

/** Whether `file` exists and is a regular file. */
async function isFile(file: string): Promise<boolean> {
  const stats = await stat(file).catch(() => undefined);
  return stats?.isFile() ?? false;
}

/**
 * The single skill a `<dir>/SKILL.md` folder holds: `loadSkills` on the
 * parent (its frontmatter parsing and messages are reused), keeping the
 * skill whose `directory` is `dir`.
 */
async function folderSkill(dir: string): Promise<Skill | undefined> {
  const skills = await loadSkills(path.dirname(dir));
  return skills.find((skill) => skill.directory !== undefined && path.resolve(skill.directory) === path.resolve(dir));
}

/**
 * `{ dir }` inside `host.baseDir`: a folder holding its own `SKILL.md`
 * resolves to that one skill; otherwise to every skill `loadSkills` finds
 * inside (`<name>/SKILL.md` and `<name>.md` entries).
 */
async function dirSkills(dir: string, host: SkillHost): Promise<Skill[]> {
  const abs = specFilePath(host.baseDir, 'skills.dir', dir);
  if (!(await isDirectory(abs))) {
    return invalid(`directory '${dir}' not found under ${host.baseDir}`);
  }
  const skills = (await isFile(path.join(abs, 'SKILL.md')))
    ? await folderSkill(abs).then((skill) => (skill === undefined ? [] : [skill]))
    : await loadSkills(abs);
  if (skills.length === 0) {
    return invalid(`no SKILL.md or <name>.md skill in '${dir}'`);
  }
  return skills;
}

/** `{ registry: name }` → the skill `lousho add` installed at `<baseDir>/skills/<name>/`. */
async function registrySkill(name: string, host: SkillHost): Promise<Skill[]> {
  // The schema already enforces this, but resolveSkillRef also runs on unvalidated input:
  // without the check a name like '../../x' would escape baseDir.
  if (!SKILL_NAME_PATTERN.test(name)) {
    return invalid(`registry skill '${name}' is not a valid skill name (1-64 characters: lowercase a-z, 0-9, '-' and '_', starting with a letter or digit)`);
  }
  const dir = path.resolve(host.baseDir, 'skills', name);
  const skill = (await isFile(path.join(dir, 'SKILL.md'))) ? await folderSkill(dir) : undefined;
  if (skill === undefined) {
    return invalid(`registry skill '${name}' is not installed; run \`lousho add ${name} --dir ${host.baseDir}\``);
  }
  return [skill];
}

/** One ref → its skills, keyed by ref kind so the dispatch is a lookup. */
const RESOLVERS = {
  inline: (ref: Extract<SkillRef, { inline: unknown }>) => Promise.resolve([defineSkill(ref.inline)]),
  dir: (ref: Extract<SkillRef, { dir: string }>, host: SkillHost) => dirSkills(ref.dir, host),
  registry: (ref: Extract<SkillRef, { registry: string }>, host: SkillHost) => registrySkill(ref.registry, host),
};

/**
 * One `spec.skills` entry as the `Skill[]` `createAgent({ skills })` takes:
 * inline refs pass straight through `defineSkill` (its own name/description/
 * content errors stand), `{ dir }` and `{ registry }` read under
 * `host.baseDir` and report missing folders and installs as
 * `LOUSHO_SKILL_INVALID`.
 */
export async function resolveSkillRef(ref: SkillRef, host: SkillHost): Promise<Skill[]> {
  if ('dir' in ref) return RESOLVERS.dir(ref, host);
  if ('registry' in ref) return RESOLVERS.registry(ref, host);
  return RESOLVERS.inline(ref);
}
