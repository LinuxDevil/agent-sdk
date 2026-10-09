import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { AgentConfig } from '../types';
import { defineTool, type DefinedTool } from '../tools/defineTool';
import { ToolRegistry } from '../tools/ToolRegistry';
import type { Skill } from './defineSkill';
import { extendAgent } from '../execution/subagentRuntime';
import { SDKError } from '../execution/errors';
import { toolFailure } from '../tools/built-in/toolFailure';

/** Name of the tool the model uses to load a skill's full content. */
const LOAD_SKILL_TOOL = 'load_skill';
/** Name of the tool the model uses to read a file bundled with a skill. */
const READ_SKILL_FILE_TOOL = 'read_skill_file';
/** The biggest bundled file `read_skill_file` returns. */
const MAX_SKILL_FILE_BYTES = 256 * 1024;
/** How many bundled files `load_skill` lists. */
const MAX_LISTED_FILES = 50;

function skillsPromptBlock(skills: readonly Skill[]): string {
  const lines = skills.map((s) => `- ${s.name}: ${s.description.replace(/\s+/g, ' ').trim()}`);
  return [
    '## Available skills',
    '',
    `Before doing a task that one of these skills covers, call the \`${LOAD_SKILL_TOOL}\` tool with its name to read the full instructions.`,
    '',
    ...lines,
  ].join('\n');
}

function createLoadSkillTool(skills: readonly Skill[]) {
  const byName = new Map(skills.map((s) => [s.name, s]));
  return defineTool({
    name: LOAD_SKILL_TOOL,
    // N4: reading a skill changes nothing, so plan mode can use it.
    annotations: { readOnlyHint: true, destructiveHint: false },
    description:
      'Load the full instructions of a skill listed under "Available skills". Call this before doing a task the skill covers.',
    input: z.object({ name: z.string().describe('The skill name, exactly as listed') }),
    execute: ({ name }) => {
      const skill = byName.get(name);
      if (!skill) {
        throw toolFailure(`Unknown skill '${name}'. Valid skills: ${[...byName.keys()].join(', ')}.`);
      }
      return skill.directory ? withBundle(skill, skill.directory) : skill.content;
    },
  });
}

/** Relative paths of the files under `directory` (not SKILL.md), sorted, at most `limit`. */
async function bundledFiles(directory: string, limit: number): Promise<{ files: string[]; more: boolean }> {
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of entries) {
      if (files.length > limit) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && full !== path.join(directory, 'SKILL.md')) files.push(path.relative(directory, full).split(path.sep).join('/'));
    }
  };
  await walk(directory).catch(() => undefined);
  return { files: files.slice(0, limit), more: files.length > limit };
}

async function withBundle(skill: Skill, directory: string): Promise<string> {
  const { files, more } = await bundledFiles(directory, MAX_LISTED_FILES);
  if (files.length === 0) return `${skill.content}\n\n---\nSkill directory: ${directory}`;
  return [
    skill.content,
    '',
    '---',
    `Skill directory: ${directory}`,
    `Files bundled with this skill (read one with \`${READ_SKILL_FILE_TOOL}\`, skill '${skill.name}'):`,
    ...files.map((f) => `- ${f}`),
    ...(more ? ['- ...'] : []),
  ].join('\n');
}

/** `relative` resolved inside `directory`, or undefined when it points outside (`..`, an absolute path, a symlink out). */
async function confinedPath(directory: string, relative: string): Promise<string | undefined> {
  if (path.isAbsolute(relative)) return undefined;
  const root = await fs.realpath(directory);
  const candidate = path.resolve(root, relative);
  const inside = (p: string) => p === root || p.startsWith(root + path.sep);
  if (!inside(candidate)) return undefined;
  const real = await fs.realpath(candidate).catch(() => undefined);
  return real === undefined || inside(real) ? candidate : undefined;
}

function createReadSkillFileTool(skills: readonly Skill[]) {
  const bundled = new Map(skills.filter((s) => s.directory).map((s) => [s.name, s as Skill & { directory: string }]));
  return defineTool({
    name: READ_SKILL_FILE_TOOL,
    annotations: { readOnlyHint: true, destructiveHint: false },
    description:
      'Read a file bundled with a skill (a path listed by load_skill, such as FORMS.md or scripts/fill.py). Paths are relative to the skill directory and cannot leave it.',
    input: z.object({
      skill: z.string().describe('The skill name, exactly as listed'),
      path: z.string().describe('File path relative to the skill directory'),
    }),
    execute: async ({ skill: name, path: relative }) => {
      const skill = bundled.get(name);
      if (!skill) {
        throw toolFailure(`Skill '${name}' has no bundled files. Skills with files: ${[...bundled.keys()].join(', ') || 'none'}.`);
      }
      const file = await confinedPath(skill.directory, relative);
      if (!file) throw toolFailure(`'${relative}' is outside the directory of skill '${name}'. Use a path inside it.`);
      const stat = await fs.stat(file).catch(() => undefined);
      if (!stat?.isFile()) throw toolFailure(`No file '${relative}' in skill '${name}'. Use a path listed by ${LOAD_SKILL_TOOL}.`);
      if (stat.size > MAX_SKILL_FILE_BYTES) {
        throw toolFailure(`'${relative}' is ${stat.size} bytes, over the ${MAX_SKILL_FILE_BYTES} byte limit.`);
      }
      const buffer = await fs.readFile(file);
      if (buffer.includes(0)) throw toolFailure(`'${relative}' is a binary file; only text files can be read.`);
      return buffer.toString('utf8');
    },
  });
}

function assertUsable(skills: readonly Skill[], agent: AgentConfig, registry?: ToolRegistry): void {
  const reserved = skills.some((s) => s.directory) ? [LOAD_SKILL_TOOL, READ_SKILL_FILE_TOOL] : [LOAD_SKILL_TOOL];
  for (const tool of reserved) {
    if (registry?.has(tool) || agent.tools?.[tool]) {
      throw new SDKError(
        `skills: a tool named '${tool}' is already registered, but agents with skills get one automatically. ` +
          `Rename your tool, or remove the 'skills' option.`,
        'LOUSHO_SKILL_INVALID'
      );
    }
  }
  const seen = new Set<string>();
  for (const { name } of skills) {
    if (seen.has(name)) {
      throw new SDKError(`skills: duplicate skill name '${name}'. Skill names must be unique; rename one.`, 'LOUSHO_SKILL_INVALID');
    }
    seen.add(name);
  }
}

/**
 * Adds `tool` and a system-prompt `block` to an agent run, without mutating
 * the inputs. Shared by skills and sub-agents (the `task` tool).
 */
export function withPromptTool(
  agent: AgentConfig,
  toolRegistry: ToolRegistry | undefined,
  tool: DefinedTool,
  block?: string
): { agent: AgentConfig; toolRegistry: ToolRegistry } {
  const registry = new ToolRegistry();
  for (const [name, descriptor] of Object.entries(toolRegistry?.getAll() ?? {})) {
    registry.register(name, descriptor);
  }
  registry.register(tool);
  return {
    agent: extendAgent(agent, {
      prompt: block ? (agent.prompt ? `${agent.prompt}\n\n${block}` : block) : agent.prompt,
      tools: { ...agent.tools, [tool.name]: { tool: tool.name } },
    }),
    toolRegistry: registry,
  };
}

/**
 * Applies skills to an agent run: appends the "Available skills" block to the
 * system prompt and adds a `load_skill` tool. Inputs are not mutated; with no
 * skills they are returned as is.
 */
export function withSkills(
  agent: AgentConfig,
  toolRegistry: ToolRegistry | undefined,
  skills: readonly Skill[] | undefined
): { agent: AgentConfig; toolRegistry: ToolRegistry | undefined } {
  if (!skills || skills.length === 0) return { agent, toolRegistry };
  assertUsable(skills, agent, toolRegistry);
  const loaded = withPromptTool(agent, toolRegistry, createLoadSkillTool(skills), skillsPromptBlock(skills));
  // Folder skills bring files: the model reads them through a tool confined to the skill's directory.
  return skills.some((s) => s.directory) ? withPromptTool(loaded.agent, loaded.toolRegistry, createReadSkillFileTool(skills)) : loaded;
}
