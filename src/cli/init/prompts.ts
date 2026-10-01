import prompts, { type PromptObject } from 'prompts';
import { PROVIDER_NAMES, TEMPLATES } from './options';

/** The answers `loushy init` can ask for; a key is only asked when it is missing. */
export interface InitAnswers {
  dir: string;
  provider: string;
  template: string;
}

/** What is already known (from flags) plus the defaults to pre-select. */
export interface AskInput {
  known: Partial<InitAnswers>;
  defaults: InitAnswers;
}

const TEMPLATE_HINTS: Record<string, string> = {
  minimal: 'one agent, one example tool, an offline test',
  tools: 'several example tools',
  yaml: 'an agent.yaml spec, run with `loushy dev`',
};

function choices(values: readonly string[], hints: Record<string, string> = {}) {
  return values.map((value) => ({ title: value, value, description: hints[value] }));
}

function questions({ known, defaults }: AskInput): PromptObject<keyof InitAnswers>[] {
  const all: PromptObject<keyof InitAnswers>[] = [
    { type: 'text', name: 'dir', message: 'Project directory', initial: defaults.dir },
    {
      type: 'select',
      name: 'provider',
      message: 'LLM provider',
      choices: choices(PROVIDER_NAMES),
      initial: Math.max(0, PROVIDER_NAMES.indexOf(defaults.provider)),
    },
    {
      type: 'select',
      name: 'template',
      message: 'Template',
      choices: choices(TEMPLATES, TEMPLATE_HINTS),
      initial: Math.max(0, TEMPLATES.indexOf(defaults.template as (typeof TEMPLATES)[number])),
    },
  ];
  return all.filter((question) => known[question.name as keyof InitAnswers] === undefined);
}

/**
 * Interactively asks only for the answers not already given as flags, using
 * the `prompts` library (tests drive it with `prompts.inject()`). Ctrl+C
 * cancels the whole scaffold.
 */
export async function askMissing(input: AskInput): Promise<InitAnswers> {
  let cancelled = false;
  const response = await prompts(questions(input), {
    onCancel: () => {
      cancelled = true;
      return false;
    },
  });
  if (cancelled) throw new Error('loushy init: cancelled.');
  return { ...input.defaults, ...input.known, ...response };
}
