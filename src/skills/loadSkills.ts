import { promises as fs, type Dirent } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { defineSkill, type Skill } from './defineSkill';
import { SDKError } from '../execution/errors';

const FRONTMATTER = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

interface SkillSource {
  /** Skill name implied by the folder / file name. */
  defaultName: string;
  file: string;
  /** The skill's folder, for a `<name>/SKILL.md` skill (its bundled files live there). */
  directory?: string;
}

function problem(file: string, message: string): SDKError {
  return new SDKError(`loadSkills: ${file}: ${message}`, 'LOUSHO_SKILL_INVALID');
}

function parseFrontmatter(file: string, raw: string): { meta: Record<string, unknown>; body: string } {
  const match = FRONTMATTER.exec(raw);
  if (!match) return { meta: {}, body: raw };
  let meta: unknown;
  try {
    meta = parseYaml(match[1]);
  } catch (error) {
    throw problem(
      file,
      `invalid YAML frontmatter (${(error as Error).message}). Fix the YAML between the leading '---' lines.`
    );
  }
  if (meta !== null && meta !== undefined && (typeof meta !== 'object' || Array.isArray(meta))) {
    throw problem(file, "frontmatter must be a YAML mapping such as 'description: ...'.");
  }
  return { meta: (meta ?? {}) as Record<string, unknown>, body: raw.slice(match[0].length) };
}

/** The skill a file defines, or undefined for a loose markdown file with no frontmatter (a README, notes), which is skipped with a warning. */
async function readSkill(source: SkillSource): Promise<Skill | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(source.file, 'utf8');
  } catch (error) {
    throw problem(source.file, `cannot read file (${(error as Error).message})`);
  }
  if (!source.directory && !FRONTMATTER.test(raw)) {
    console.warn(
      `[lousho] loadSkills: skipping ${source.file}: no YAML frontmatter, so it is not a skill. ` +
        'Add a leading block with a description to make it one:\n---\ndescription: When the model should use this skill\n---'
    );
    return undefined;
  }
  const { meta, body } = parseFrontmatter(source.file, raw);
  if (typeof meta.description !== 'string' || meta.description.trim() === '') {
    throw problem(
      source.file,
      "missing 'description' in the frontmatter. Add a block at the top of the file:\n---\ndescription: When the model should use this skill\n---"
    );
  }
  const name = typeof meta.name === 'string' && meta.name !== '' ? meta.name : source.defaultName;
  try {
    return defineSkill({
      name,
      description: meta.description,
      content: body.trim(),
      ...(source.directory ? { directory: source.directory } : {}),
    });
  } catch (error) {
    throw problem(source.file, (error as Error).message.replace(/^defineSkill: /, ''));
  }
}

async function isFile(file: string): Promise<boolean> {
  return fs.stat(file).then(
    (s) => s.isFile(),
    () => false
  );
}

async function sourceOf(dir: string, entry: Dirent): Promise<SkillSource | undefined> {
  if (entry.isDirectory()) {
    const file = path.join(dir, entry.name, 'SKILL.md');
    return (await isFile(file)) ? { defaultName: entry.name, file, directory: path.resolve(dir, entry.name) } : undefined;
  }
  if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
    return { defaultName: entry.name.slice(0, -'.md'.length), file: path.join(dir, entry.name) };
  }
  return undefined;
}

async function listSources(dir: string): Promise<SkillSource[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    throw new SDKError(
      `loadSkills: cannot read skills directory '${dir}' (${(error as Error).message}). ` +
        `Check the path, or create it with a skill inside, e.g. ${path.join(dir, 'my-skill', 'SKILL.md')}.`,
      'LOUSHO_SKILL_INVALID'
    );
  }
  const sources = await Promise.all(entries.map((entry) => sourceOf(dir, entry)));
  return sources.filter((s): s is SkillSource => s !== undefined);
}

/**
 * Load skills from a directory. Two layouts are understood and can be mixed:
 *
 * - `dir/<name>/SKILL.md` (Anthropic / open-harness convention)
 * - `dir/<name>.md` (eve convention)
 *
 * Each file has YAML frontmatter with a required `description` and an
 * optional `name` (defaults to the folder / file name); the markdown body is
 * the skill's content. Folders without a `SKILL.md` are ignored, and so is a
 * loose `.md` file with no frontmatter (a `README.md`), with a console
 * warning. A folder skill records its `directory`, so its bundled files can be
 * read through `read_skill_file`. The result is sorted by name. A malformed
 * skill throws a `LOUSHO_SKILL_INVALID` error naming the offending file.
 *
 * @example
 * ```ts
 * const agent = createAgent({
 *   prompt: 'You are a release engineer.',
 *   provider,
 *   skills: await loadSkills('./skills'),
 * });
 * ```
 */
export async function loadSkills(dir: string): Promise<Skill[]> {
  const sources = await listSources(dir);
  const byName = new Map<string, { skill: Skill; file: string }>();
  for (const source of sources) {
    const skill = await readSkill(source);
    if (!skill) continue;
    const earlier = byName.get(skill.name);
    if (earlier) {
      throw new SDKError(
        `loadSkills: duplicate skill name '${skill.name}' in ${earlier.file} and ${source.file}. ` +
          `Rename one file/folder or set a different 'name' in its frontmatter.`,
        'LOUSHO_SKILL_INVALID'
      );
    }
    byName.set(skill.name, { skill, file: source.file });
  }
  return [...byName.values()].map((v) => v.skill).sort((a, b) => (a.name < b.name ? -1 : 1));
}
