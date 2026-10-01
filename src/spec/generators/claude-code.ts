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

function buildFrontmatter(spec: AgentSpec): string {
  return [
    '---',
    `name: ${yamlScalar(spec.name)}`,
    `description: ${yamlScalar(buildDescription(spec.prompt))}`,
    '---',
  ].join('\n');
}

function buildToolsSection(tools: string[]): string {
  const items = tools.length > 0 ? tools.map((t) => `- \`${t}\``) : ['(none)'];
  return ['## Tools', '', ...items].join('\n');
}

function buildApprovalLine(policy: NonNullable<AgentSpec['policy']>): string {
  return policy.requiresApproval
    ? '- Tool calls from this agent require human approval before running.'
    : '- Tool calls from this agent do not require approval.';
}

function buildGuardrailLines(policy: NonNullable<AgentSpec['policy']>): string[] {
  const guardrails = (policy.guardrails ?? []).map((entry) => (typeof entry === 'string' ? entry : entry.name));
  return guardrails.length > 0 ? [`- Guardrails: ${guardrails.join(', ')}`] : [];
}

function buildPolicySection(policy: AgentSpec['policy']): string {
  if (!policy) return '';
  return ['## Policy', '', buildApprovalLine(policy), ...buildGuardrailLines(policy)].join('\n');
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
  const policySection = buildPolicySection(spec.policy);

  const body = [
    buildFrontmatter(spec),
    '',
    `# ${spec.name}`,
    '',
    '## Prompt',
    '',
    spec.prompt,
    '',
    buildToolsSection(spec.tools ?? []),
    ...(policySection ? ['', policySection] : []),
    '',
  ].join('\n');

  return {
    path: `.claude/skills/${slug}/SKILL.md`,
    content: body,
  };
}
