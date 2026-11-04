import { promptInjectionSignals } from '../execution/guardrailStarterSet';
import type { FsProvider } from '../tools/workspace/types';
import type { Harness } from './types';

const SKILL_NAME = /^[a-z0-9][a-z0-9-]*$/;
const INSTRUCTIONS_PATH = 'harness/instructions.md';
const SKILLS_DIR = 'harness/skills';

function skillFile(description: string, content: string, name: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${content}\n`;
}

function parseSkill(text: string): { description: string; content: string } | undefined {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!match) return undefined;
  const description = /^description:\s*(.*)$/m.exec(match[1])?.[1]?.trim();
  if (description === undefined) return undefined;
  return { description, content: match[2].trim() };
}

export function harnessFiles(harness: Harness): Record<string, string> {
  const files: Record<string, string> = { [INSTRUCTIONS_PATH]: harness.instructions };
  for (const [name, skill] of Object.entries(harness.skills)) {
    files[`${SKILLS_DIR}/${name}/SKILL.md`] = skillFile(skill.description, skill.content, name);
  }
  return files;
}

async function childDirs(fs: FsProvider, path: string): Promise<string[]> {
  if (!(await fs.stat(path))) return [];
  return (await fs.readdir(path)).filter((entry) => entry.type === 'directory').map((entry) => entry.name);
}

async function unexpectedFiles(fs: FsProvider, skills: readonly string[]): Promise<string[]> {
  const top = (await fs.readdir('harness')).map((entry) => entry.name).filter((name) => name !== 'instructions.md' && name !== 'skills');
  const nested = await Promise.all(
    skills.map(async (name) => (await fs.readdir(`${SKILLS_DIR}/${name}`)).map((entry) => entry.name).filter((file) => file !== 'SKILL.md').map((file) => `skills/${name}/${file}`))
  );
  return [...top, ...nested.flat()];
}

export async function readHarness(fs: FsProvider): Promise<{ harness: Harness; errors: string[] }> {
  const errors: string[] = [];
  const instructions = (await fs.stat(INSTRUCTIONS_PATH)) ? await fs.readFile(INSTRUCTIONS_PATH) : '';
  const skills: Harness['skills'] = {};
  const names = await childDirs(fs, SKILLS_DIR);
  for (const name of names) {
    const path = `${SKILLS_DIR}/${name}/SKILL.md`;
    const parsed = (await fs.stat(path)) ? parseSkill(await fs.readFile(path)) : undefined;
    if (parsed) skills[name] = parsed;
    else errors.push(`${path} needs frontmatter with a description.`);
  }
  for (const file of await unexpectedFiles(fs, names)) errors.push(`${file} is outside the editable files; only instructions.md and skills/<name>/SKILL.md can change.`);
  return { harness: { instructions, skills }, errors };
}

function addedText(current: string, base: string): string {
  const existing = new Set(base.split('\n'));
  return current
    .split('\n')
    .filter((line) => !existing.has(line) && ![...existing].some((old) => old.length > 0 && line.includes(old)))
    .join('\n');
}

function skillErrors(harness: Harness, base: Harness): string[] {
  return Object.entries(harness.skills).flatMap(([name, skill]) => {
    const errors: string[] = [];
    if (!SKILL_NAME.test(name)) errors.push(`'${name}' is not a valid skill name: use lowercase letters, digits and hyphens.`);
    if (!skill.description.trim()) errors.push(`Skill '${name}' needs a description.`);
    if (!skill.content.trim()) errors.push(`Skill '${name}' needs content.`);
    const signals = promptInjectionSignals(addedText(skill.content, base.skills[name]?.content ?? ''));
    if (signals.length > 0) errors.push(`Skill '${name}' adds text that looks like prompt injection (${signals.join(', ')}).`);
    return errors;
  });
}

export function validateHarness(harness: Harness, base: Harness, limits: { maxAlwaysOnChars: number }): string[] {
  const errors: string[] = [];
  if (!harness.instructions.trim()) errors.push('The instructions are empty.');
  if (harness.instructions.length > limits.maxAlwaysOnChars) errors.push(`The instructions are ${harness.instructions.length} characters, over the ${limits.maxAlwaysOnChars} limit. Move detail into a skill.`);
  const signals = promptInjectionSignals(addedText(harness.instructions, base.instructions));
  if (signals.length > 0) errors.push(`The instructions add text that looks like prompt injection (${signals.join(', ')}).`);
  return [...errors, ...skillErrors(harness, base)];
}

function lineChanges(before: string, after: string): string[] {
  const old = before.split('\n');
  const next = after.split('\n');
  return [...old.filter((line) => !next.includes(line)).map((line) => `- ${line}`), ...next.filter((line) => !old.includes(line)).map((line) => `+ ${line}`)];
}

export function diffHarness(before: Harness, after: Harness): string {
  const oldFiles = harnessFiles(before);
  const newFiles = harnessFiles(after);
  const paths = [...new Set([...Object.keys(oldFiles), ...Object.keys(newFiles)])].sort();
  return paths
    .flatMap((path) => {
      const changes = lineChanges(oldFiles[path] ?? '', newFiles[path] ?? '');
      return changes.length === 0 ? [] : [`${path.replace('harness/', '')}\n${changes.join('\n')}`];
    })
    .join('\n\n');
}
