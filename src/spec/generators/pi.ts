/**
 * Pi generator (LOU-J3)
 *
 * Turns an AgentSpec into a Pi skill YAML file. Reuses the `yaml` package
 * that's already a project dependency (added for loadSpec.ts's .yaml/.yml
 * parsing - see src/spec/loadSpec.ts) for stringifying, rather than adding
 * a new YAML dependency just for this generator.
 */
import { stringify as stringifyYaml } from 'yaml';
import { AgentSpec } from '../schema';
import { GeneratedFile } from './claude-code';

function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * The plain-data shape serialized to YAML for a Pi skill. Kept close to
 * AgentSpec itself (Pi's skill format, like the source AgentSpec, is a
 * name/prompt/tools/provider/policy/triggers record) rather than
 * introducing an unrelated schema.
 */
export interface PiSkillDocument {
  name: string;
  prompt: string;
  tools: string[];
  provider: AgentSpec['provider'];
  policy?: AgentSpec['policy'];
  triggers?: AgentSpec['triggers'];
}

/**
 * Generates a Pi skill YAML file for `spec`.
 */
export function generatePiSkill(spec: AgentSpec): GeneratedFile {
  const doc: PiSkillDocument = {
    name: spec.name,
    prompt: spec.prompt,
    tools: spec.tools ?? [],
    provider: spec.provider,
    ...(spec.policy ? { policy: spec.policy } : {}),
    ...(spec.triggers ? { triggers: spec.triggers } : {}),
  };

  return {
    path: `.pi/skills/${slugify(spec.name)}.yaml`,
    content: stringifyYaml(doc),
  };
}
