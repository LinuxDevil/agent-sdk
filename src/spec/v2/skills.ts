/**
 * The `spec.skills` section of AgentSpec v2: a list of `SkillRef`s, one
 * object per skill source — `{ dir }` for a folder of skills (or a single
 * `<dir>/SKILL.md` skill) inside the agent's folder, `{ registry }` for a
 * skill `lousho add` installed under `<base>/skills/<name>/`, and
 * `{ inline }` for a skill kept inside the spec itself. `resolve/skills.ts`
 * turns each ref into the `Skill[]` `createAgent({ skills })` takes.
 * Browser-safe: no `node:*` imports.
 */
import { z } from 'zod';
import { SKILL_NAME_PATTERN } from '../../skills/defineSkill';
import { anyError } from '../../utils/zodCompat';

/** One `spec.skills` entry: where the skills come from; exactly one kind key per entry. */
export type SkillRef =
  | {
      /** Folder relative to the spec's base directory: its own `SKILL.md` skill, or every `<name>/SKILL.md` and `<name>.md` inside. */
      dir: string;
    }
  | {
      /** Name of a skill `lousho add` installed under `<base>/skills/<name>/` (a `SKILL_NAME_PATTERN` name). */
      registry: string;
    }
  | {
      /** A skill kept inside the spec itself (skills are fully serializable). */
      inline: {
        /** Name the model loads the skill by (`SKILL_NAME_PATTERN`). */
        name: string;
        /** One line telling the model when the skill applies. */
        description: string;
        /** The markdown instructions the model receives when it loads the skill. */
        content: string;
      };
    };

const dirRef = z.object({ dir: z.string().min(1, 'must not be empty') }).strict();

const registryRef = z
  .object({ registry: z.string().regex(SKILL_NAME_PATTERN, 'must be a skill name such as changelog') })
  .strict();

const inlineRef = z
  .object({
    inline: z
      .object({
        name: z
          .string()
          .regex(
            SKILL_NAME_PATTERN,
            "must be 1-64 characters: lowercase a-z, 0-9, '-' and '_', starting with a letter or digit"
          ),
        description: z.string().min(1, 'must not be empty'),
        content: z.string().min(1, 'must not be empty'),
      })
      .strict(),
  })
  .strict();

/**
 * One `spec.skills` entry (zod): a strict union of the three ref forms —
 * every member is a strict object with exactly its one key, so an entry
 * mixing two kinds fails. The union-level message names the three forms.
 */
export const skillRefSchema: z.ZodType<SkillRef> = z.union(
  [dirRef, registryRef, inlineRef],
  anyError('each skills entry must be { dir }, { registry } or { inline: { name, description, content } }')
);

/** The `spec.skills` list (zod): inline skill names must be unique (resolved names are checked by createAgent). */
export const skillRefListSchema: z.ZodType<SkillRef[]> = z.array(skillRefSchema).superRefine((refs, ctx) => {
  const seen = new Set<string>();
  for (let index = 0; index < refs.length; index++) {
    const ref = refs[index];
    if (!('inline' in ref)) continue;
    if (seen.has(ref.inline.name)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `duplicate skill name '${ref.inline.name}'`,
        path: [index, 'inline', 'name'],
      });
    }
    seen.add(ref.inline.name);
  }
});
