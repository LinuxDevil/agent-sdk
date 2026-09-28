/**
 * Codex generator (LOU-J2)
 *
 * Turns an AgentSpec into a Codex-style agent-config JSON file.
 *
 * Uncertainty note: OpenAI Codex CLI's agent-config format is not something
 * this repo has a copy of or a dependency on to verify against precisely,
 * and no network research was performed as part of writing this generator.
 * The shape below follows the LOU-J2 ticket's own illustrative shape as the
 * best-effort baseline: a top-level `instructions` field carries the
 * prompt (matching Codex's documented convention of an `instructions`
 * field for agent system prompts, as opposed to Claude Code's `prompt`/
 * skill-body convention), `model`/`provider` carry the target model,
 * `tools` is a flat array of tool names, and `policy`/`triggers` are
 * passed through verbatim when present. If Codex's real schema differs
 * (e.g. different field names or nesting), this generator's output shape
 * will need to be adjusted to match - flagged here rather than silently
 * assumed correct.
 */
import { AgentSpec } from '../schema';
import { GeneratedFile } from './claude-code';

/**
 * The Codex agent-config JSON shape this generator produces. See the
 * uncertainty note above this generator's doc comment.
 */
export interface CodexAgentConfig {
  name: string;
  instructions: string;
  model: {
    provider: string;
    name: string;
  };
  tools: string[];
  policy?: AgentSpec['policy'];
  triggers?: AgentSpec['triggers'];
}

function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Generates a Codex agent-config JSON file for `spec`.
 */
export function generateCodexConfig(spec: AgentSpec): GeneratedFile {
  const config: CodexAgentConfig = {
    name: spec.name,
    instructions: spec.prompt,
    model: {
      provider: spec.provider.type,
      name: spec.provider.model,
    },
    tools: spec.tools ?? [],
    ...(spec.policy ? { policy: spec.policy } : {}),
    ...(spec.triggers ? { triggers: spec.triggers } : {}),
  };

  return {
    path: `.codex/agents/${slugify(spec.name)}.json`,
    content: JSON.stringify(config, null, 2) + '\n',
  };
}
