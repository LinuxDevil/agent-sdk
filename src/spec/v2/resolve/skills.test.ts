import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import { skillRefSchema } from '../skills';
import { resolveSkillRef } from './skills';

const repo = path.resolve(__dirname, '..', '..', '..', '..');
const changelogSrc = path.join(repo, 'registry', 'changelog', 'skills', 'changelog');
const codeReviewSrc = path.join(repo, 'registry', 'code-review', 'skills', 'code-review');

function baseDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'lousho-skills-'));
}

/** `<base>/skills/changelog` (and optionally code-review) from the repo's registry copies. */
function installSkills(base: string, names: readonly ('changelog' | 'code-review')[] = ['changelog']): string {
  const skillsDir = path.join(base, 'skills');
  mkdirSync(skillsDir, { recursive: true });
  for (const name of names) {
    cpSync(name === 'changelog' ? changelogSrc : codeReviewSrc, path.join(skillsDir, name), { recursive: true });
  }
  return skillsDir;
}

describe('resolveSkillRef', () => {
  it('resolves an inline ref to one Skill with no directory', async () => {
    const skills = await resolveSkillRef(
      { inline: { name: 'tone', description: 'House tone', content: 'Write plainly.' } },
      { baseDir: baseDir() }
    );
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({ name: 'tone', description: 'House tone', content: 'Write plainly.' });
    expect(skills[0].directory).toBeUndefined();
  });

  it('resolves { dir } at a single-skill folder to that skill, directory set', async () => {
    const base = baseDir();
    installSkills(base);
    const skills = await resolveSkillRef({ dir: 'skills/changelog' }, { baseDir: base });
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('changelog');
    expect(skills[0].directory).toBe(path.join(base, 'skills', 'changelog'));
  });

  it('resolves { dir } at a folder of skills to all of them, sorted by name', async () => {
    const base = baseDir();
    installSkills(base, ['code-review', 'changelog']);
    const skills = await resolveSkillRef({ dir: 'skills' }, { baseDir: base });
    expect(skills.map((skill) => skill.name)).toEqual(['changelog', 'code-review']);
  });

  it('resolves { registry } to the skill installed under skills/<name>', async () => {
    const base = baseDir();
    installSkills(base);
    const skills = await resolveSkillRef({ registry: 'changelog' }, { baseDir: base });
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('changelog');
    expect(skills[0].directory).toBe(path.join(base, 'skills', 'changelog'));
  });

  it("rejects a registry skill that is not installed, naming 'lousho add'", async () => {
    const base = baseDir();
    await expect(resolveSkillRef({ registry: 'changelog' }, { baseDir: base })).rejects.toMatchObject({
      code: 'LOUSHO_SKILL_INVALID',
      message: expect.stringContaining(
        `skills: registry skill 'changelog' is not installed; run \`lousho add changelog --dir ${base}\``
      ),
    });
  });

  it('rejects a { dir } that does not exist', async () => {
    const base = baseDir();
    await expect(resolveSkillRef({ dir: 'skills' }, { baseDir: base })).rejects.toMatchObject({
      code: 'LOUSHO_SKILL_INVALID',
      message: expect.stringContaining(`skills: directory 'skills' not found under ${base}`),
    });
  });

  it('rejects a { dir } that exists but yields no skill', async () => {
    const base = baseDir();
    mkdirSync(path.join(base, 'skills'));
    writeFileSync(path.join(base, 'skills', 'README.txt'), 'nothing here');
    await expect(resolveSkillRef({ dir: 'skills' }, { baseDir: base })).rejects.toMatchObject({
      code: 'LOUSHO_SKILL_INVALID',
      message: expect.stringContaining("skills: no SKILL.md or <name>.md skill in 'skills'"),
    });
  });

  it('rejects a { dir } that escapes the base directory', async () => {
    const base = baseDir();
    await expect(resolveSkillRef({ dir: '../x' }, { baseDir: base })).rejects.toMatchObject({
      code: 'LOUSHO_SPEC_INVALID',
      message: expect.stringContaining('must be a relative path inside'),
    });
  });

  it('rejects a { registry } name that would escape skills/, even unvalidated', async () => {
    const base = baseDir();
    await expect(resolveSkillRef({ registry: '../../x' }, { baseDir: base })).rejects.toMatchObject({
      code: 'LOUSHO_SKILL_INVALID',
      message: expect.stringContaining("'../../x' is not a valid skill name"),
    });
  });

  it('rejects an entry with two kind keys at parse time', () => {
    expect(skillRefSchema.safeParse({ dir: 'x', registry: 'y' }).success).toBe(false);
  });
});
