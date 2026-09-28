/**
 * Claude Code generator (LOU-J1)
 *
 * Turns a cross-harness AgentSpec (LOU-H9, extended with `policy`/`triggers`
 * in LOU-J1) into a real Claude Code Skill file (SKILL.md).
 *
 * This repository does not itself ship a `.claude/skills/` directory (there
 * is nothing under `.claude/` to mirror the frontmatter shape from), so the
 * frontmatter below follows Claude Code's own documented Skill format: a
 * YAML frontmatter block with the two fields every skill needs - `name`
 * (a short identifier) and `description` (what the skill does / when to use
 * it, since that's what Claude Code's skill picker matches against) -
 * followed by the skill's instructions as Markdown body content.
 */
import { AgentSpec } from '../schema';

/**
 * A generated file: where it should be written, and its full content.
 */
export interface GeneratedFile {
  path: string;
  content: string;
}

/**
 * Slugifies an AgentSpec name into a filesystem/frontmatter-safe skill
 * name: lowercase, spaces/underscores collapsed to single hyphens, and
 * anything that isn't a-z/0-9/hyphen stripped.
 */
function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Builds a one-line description for the SKILL.md frontmatter from the
 * spec's prompt: the first sentence (or the whole prompt if it has none),
 * truncated to a reasonable frontmatter-friendly length.
 */
function buildDescription(prompt: string): string {
  const firstSentence = prompt.split(/(?<=[.!?])\s/)[0] || prompt;
  const trimmed = firstSentence.trim();
  return trimmed.length > 200 ? `${trimmed.slice(0, 197)}...` : trimmed;
}

/**
 * Escapes a value for safe embedding in a single YAML frontmatter scalar
 * (wraps in double quotes, escapes embedded double quotes/backslashes).
 */
function yamlScalar(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Generates a Claude Code SKILL.md for `spec`.
 *
 * The full spec prompt is preserved verbatim in the Markdown body (not
 * truncated) - only the frontmatter `description` is shortened, since that
 * field exists purely for the skill picker, not to carry the whole prompt.
 * Every tool from `spec.tools` is listed explicitly so a reader (or the
 * LOU-J1 test) can see exactly which tools this skill expects to be
 * available.
 */
export function generateClaudeCodeSkill(spec: AgentSpec): GeneratedFile {
  const slug = slugify(spec.name);
  const description = buildDescription(spec.prompt);
  const tools = spec.tools ?? [];

  const frontmatter = [
    '---',
    `name: ${yamlScalar(spec.name)}`,
    `description: ${yamlScalar(description)}`,
    '---',
  ].join('\n');

  const toolsSection =
    tools.length > 0
      ? ['## Tools', '', ...tools.map((t) => `- \`${t}\``)].join('\n')
      : ['## Tools', '', '(none)'].join('\n');

  const policySection = spec.policy
    ? [
        '## Policy',
        '',
        spec.policy.requiresApproval
          ? '- Tool calls from this agent require human approval before running.'
          : '- Tool calls from this agent do not require approval.',
        ...(spec.policy.guardrails && spec.policy.guardrails.length > 0
          ? [`- Guardrails: ${spec.policy.guardrails.join(', ')}`]
          : []),
      ].join('\n')
    : '';

  const body = [
    frontmatter,
    '',
    `# ${spec.name}`,
    '',
    '## Prompt',
    '',
    spec.prompt,
    '',
    toolsSection,
    ...(policySection ? ['', policySection] : []),
    '',
  ].join('\n');

  return {
    path: `.claude/skills/${slug}/SKILL.md`,
    content: body,
  };
}
