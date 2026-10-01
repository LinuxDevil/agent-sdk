/** Skill names are file/tool friendly: lowercase, digits, `-` and `_`, 1-64 characters. */
const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-_]{0,63}$/;

/** Options accepted by {@link defineSkill}. */
export interface DefineSkillOptions {
  /** Name the model loads the skill by. Must match `^[a-z0-9][a-z0-9-_]{0,63}$`. */
  name: string;
  /** One line telling the model when the skill applies. Always in the system prompt. */
  description: string;
  /** The full instructions (markdown). Only sent to the model once it calls `load_skill`. */
  content: string;
}

/**
 * A named bundle of instructions the model loads on demand. Only `name` and
 * `description` sit in the system prompt; `content` is returned by the
 * auto-registered `load_skill` tool. Create one with {@link defineSkill} or
 * {@link loadSkills}.
 */
export interface Skill {
  readonly name: string;
  readonly description: string;
  readonly content: string;
}

function fail(problem: string, fix: string): never {
  throw new Error(`defineSkill: ${problem}. ${fix}`);
}

function assertNonEmpty(name: string, field: 'description' | 'content', value: unknown): void {
  if (typeof value === 'string' && value.trim() !== '') return;
  const hint =
    field === 'description'
      ? 'a one-line summary the model uses to decide when to load the skill'
      : 'the markdown instructions the model receives when it loads the skill';
  fail(
    `skill '${name}' is missing a non-empty '${field}' (${hint})`,
    `Example: defineSkill({ name: '${name}', description: 'When to use it', content: '# Steps...' })`
  );
}

function assertName(name: unknown): asserts name is string {
  if (typeof name !== 'string' || name === '') {
    fail("'name' is required", "Example: defineSkill({ name: 'changelog', ... })");
  }
  if (!SKILL_NAME_PATTERN.test(name)) {
    const suggestion =
      name
        .toLowerCase()
        .replace(/[^a-z0-9-_]+/g, '-')
        .replace(/^[-_]+/, '')
        .slice(0, 64) || 'my-skill';
    fail(
      `invalid skill name ${JSON.stringify(name)} (use 1-64 characters: lowercase a-z, 0-9, '-' and '_', starting with a letter or digit)`,
      `Rename it, e.g. ${JSON.stringify(suggestion)}`
    );
  }
}

/**
 * Define a skill: instructions the model pulls in only when it needs them
 * (progressive disclosure). Pass skills to `createAgent({ skills })` or
 * `AgentExecutor.execute({ skills })`.
 *
 * @example
 * ```ts
 * const changelog = defineSkill({
 *   name: 'changelog',
 *   description: 'How to write a changelog entry',
 *   content: '# Changelog entries\n\nUse the imperative mood and link the PR.',
 * });
 * ```
 */
export function defineSkill(opts: DefineSkillOptions): Skill {
  const { name, description, content } = opts ?? ({} as Partial<DefineSkillOptions>);
  assertName(name);
  assertNonEmpty(name, 'description', description);
  assertNonEmpty(name, 'content', content);
  return Object.freeze({ name, description: description.trim(), content });
}
