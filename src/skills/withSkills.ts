import { z } from 'zod';
import type { AgentConfig } from '../types';
import { defineTool } from '../tools/defineTool';
import { ToolRegistry } from '../tools/ToolRegistry';
import type { Skill } from './defineSkill';

/** Name of the tool the model uses to load a skill's full content. */
const LOAD_SKILL_TOOL = 'load_skill';

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
    description:
      'Load the full instructions of a skill listed under "Available skills". Call this before doing a task the skill covers.',
    input: z.object({ name: z.string().describe('The skill name, exactly as listed') }),
    execute: ({ name }) => {
      const skill = byName.get(name);
      if (!skill) {
        throw new Error(`Unknown skill '${name}'. Valid skills: ${[...byName.keys()].join(', ')}.`);
      }
      return skill.content;
    },
  });
}

function assertUsable(skills: readonly Skill[], agent: AgentConfig, registry?: ToolRegistry): void {
  if (registry?.has(LOAD_SKILL_TOOL) || agent.tools?.[LOAD_SKILL_TOOL]) {
    throw new Error(
      `skills: a tool named '${LOAD_SKILL_TOOL}' is already registered, but agents with skills get one automatically. ` +
        `Rename your tool, or remove the 'skills' option.`
    );
  }
  const seen = new Set<string>();
  for (const { name } of skills) {
    if (seen.has(name)) {
      throw new Error(`skills: duplicate skill name '${name}'. Skill names must be unique; rename one.`);
    }
    seen.add(name);
  }
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

  const registry = new ToolRegistry();
  for (const [name, descriptor] of Object.entries(toolRegistry?.getAll() ?? {})) {
    registry.register(name, descriptor);
  }
  registry.register(createLoadSkillTool(skills));

  const block = skillsPromptBlock(skills);
  return {
    agent: {
      ...agent,
      prompt: agent.prompt ? `${agent.prompt}\n\n${block}` : block,
      tools: { ...agent.tools, [LOAD_SKILL_TOOL]: { tool: LOAD_SKILL_TOOL } },
    },
    toolRegistry: registry,
  };
}
