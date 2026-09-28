import prompts from 'prompts';

export const PROVIDERS = ['openai', 'anthropic', 'ollama'] as const;
export type Provider = (typeof PROVIDERS)[number];

export const TOOL_CHOICES = ['http', 'github'] as const;

export interface AnswerConfig {
  name: string;
  provider: Provider;
  tools: string[];
}

/**
 * Interactively collects the answers needed to scaffold a project: project
 * name (text), provider (select), tools (multiselect). Uses the `prompts`
 * library, which supports non-interactive testing via `prompts.inject()` -
 * tests call that before invoking collectAnswers() instead of driving a
 * real TTY.
 */
export async function collectAnswers(): Promise<AnswerConfig> {
  const response = await prompts([
    {
      type: 'text',
      name: 'name',
      message: 'Project name',
      initial: 'my-loushy-agent',
    },
    {
      type: 'select',
      name: 'provider',
      message: 'LLM provider',
      choices: PROVIDERS.map((p) => ({ title: p, value: p })),
      initial: 0,
    },
    {
      type: 'multiselect',
      name: 'tools',
      message: 'Starter tools',
      choices: TOOL_CHOICES.map((t) => ({ title: t, value: t })),
    },
  ]);

  return validateAnswers({
    name: response.name,
    provider: response.provider,
    tools: response.tools || [],
  });
}

/**
 * Validates an AnswerConfig, throwing a clear error naming the invalid
 * value and the allowed set. Used both after interactive collection and
 * whenever a non-interactive flag override (--provider) supplies a
 * provider value directly, bypassing the select prompt's own restricted
 * choice list.
 */
export function validateAnswers(answers: {
  name: string;
  provider: string;
  tools: string[];
}): AnswerConfig {
  if (!answers.name || !answers.name.trim()) {
    throw new Error('collectAnswers: a project name is required');
  }
  if (!(PROVIDERS as readonly string[]).includes(answers.provider)) {
    throw new Error(
      `collectAnswers: invalid provider '${answers.provider}'. Allowed values: ${PROVIDERS.join(', ')}`
    );
  }
  return {
    name: answers.name.trim(),
    provider: answers.provider as Provider,
    tools: answers.tools,
  };
}
