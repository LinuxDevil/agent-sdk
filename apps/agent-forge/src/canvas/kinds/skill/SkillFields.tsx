/**
 * The `skill` kind's Inspector body: the Source choice swaps the
 * `SkillRef` variant (the new form starts empty, except the inline form
 * which keeps the node's current name), then one section edits that
 * variant — the folder path, the registry catalog pick (with an "Other…"
 * free name for skills the index does not list) or the inline
 * name/description/content.
 */
import type { ChangeEvent } from 'react';
import { SKILL_NAME_PATTERN, skillDirOk } from '../../../graph/v2/kinds/skill';
import { skillNodeName } from '../../../graph/v2/nodeIds';
import type { SkillRef } from '../../../graph/v2/specTypes';
import { Field } from '../../../ui/Field';
import { Input, Select, Textarea } from '../../../ui/controls';
import { SkeletonRows } from '../../../ui/Skeleton';
import { ChoiceField } from '../../fields/ChoiceField';
import { refreshCatalog, useCatalog } from '../../useCatalog';
import type { KindFieldsProps } from '../index';

/** The `SkillRef` variant the Source choice edits. */
type SkillSource = 'dir' | 'registry' | 'inline';

type Patch = KindFieldsProps<'skill'>['patch'];

const OTHER = '__other';

const SOURCE_OPTIONS: { value: SkillSource; label: string }[] = [
  { value: 'dir', label: 'Folder' },
  { value: 'registry', label: 'Registry' },
  { value: 'inline', label: 'Written here' },
];

/** Trim-empty is empty: `undefined`, non-strings and whitespace-only values all count as missing. */
function blank(value: unknown): boolean {
  return typeof value !== 'string' || value.trim() === '';
}

/** The `SkillRef` variant of `item`. */
function sourceOf(item: SkillRef): SkillSource {
  if ('dir' in item) return 'dir';
  return 'registry' in item ? 'registry' : 'inline';
}

/** The inline name a source switch seeds: the node's current name, 'skill' when it has none ('new'). */
function inlineSeedName(item: SkillRef): string {
  const name = skillNodeName(item);
  return name === 'new' ? 'skill' : name;
}

/** The `{ dir }` sub-form: a folder path inside the agent folder. */
function DirForm({ item, patch }: { item: Extract<SkillRef, { dir: string }>; patch: Patch }): JSX.Element {
  return (
    <Field
      id="node-skill-dir"
      label="Folder"
      required
      error={skillDirOk(item.dir) ? undefined : 'Use a folder inside the agent folder'}
      hint="A folder of <name>.md files or <name>/SKILL.md."
    >
      <Input
        value={item.dir}
        placeholder="skills/review"
        onChange={(event: ChangeEvent<HTMLInputElement>) => patch({ dir: event.target.value })}
      />
    </Field>
  );
}

/**
 * The `{ registry }` sub-form: a Select of the `useCatalog('skills')`
 * registry entries plus "Other…", which keeps a free `Input` open for a
 * name the catalog does not list. Loading shows a skeleton row; a failed
 * fetch shows the message and a Retry that re-arms the request.
 */
function RegistryForm({
  item,
  patch,
}: {
  item: Extract<SkillRef, { registry: string }>;
  patch: Patch;
}): JSX.Element {
  const catalog = useCatalog('skills');
  const skills = catalog.data ?? [];
  const picked = skills.find((skill) => skill.ref.registry === item.registry);
  // While the catalog loads, a non-empty name counts as listed (the select
  // is a skeleton anyway); on error it does not, so the free input stays open.
  const known = item.registry !== '' && (catalog.loading || picked !== undefined);
  return (
    <>
      <Field
        id="node-skill-registry"
        label="Skill"
        required
        error={item.registry === '' ? 'Pick a skill' : undefined}
        hint={picked?.description}
      >
        {catalog.loading ? (
          <SkeletonRows rows={1} />
        ) : catalog.error !== undefined ? (
          <div>
            <p className="hint">{catalog.error}</p>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => refreshCatalog('skills')}>
              Retry
            </button>
          </div>
        ) : (
          <Select
            options={[
              ...skills.map((skill) => ({ value: skill.ref.registry, label: skill.name })),
              { value: OTHER, label: 'Other…' },
            ]}
            value={known ? item.registry : OTHER}
            onChange={(event: ChangeEvent<HTMLSelectElement>) =>
              // "Other…" clears the name so `known` goes false and the free input stays open.
              patch({ registry: event.target.value === OTHER ? '' : event.target.value })
            }
          />
        )}
      </Field>
      {!known && (
        <Field id="node-skill-registry-other" label="Skill name" hint="A skill installed with lousho add.">
          <Input
            value={item.registry}
            onChange={(event: ChangeEvent<HTMLInputElement>) => patch({ registry: event.target.value })}
          />
        </Field>
      )}
    </>
  );
}

/** The `{ inline }` sub-form: name, description and markdown content — the whole serializable skill. */
function InlineForm({
  item,
  patch,
}: {
  item: Extract<SkillRef, { inline: unknown }>;
  patch: Patch;
}): JSX.Element {
  const { inline } = item;
  const set = (part: Partial<typeof inline>) => patch({ inline: { ...inline, ...part } });
  return (
    <>
      <Field
        id="node-skill-name"
        label="Name"
        required
        error={
          SKILL_NAME_PATTERN.test(inline.name)
            ? undefined
            : 'Use lower-case letters, digits, dash or underscore'
        }
      >
        <Input
          value={inline.name}
          onChange={(event: ChangeEvent<HTMLInputElement>) => set({ name: event.target.value })}
        />
      </Field>
      <Field
        id="node-skill-description"
        label="Description"
        required
        error={
          blank(inline.description)
            ? 'The model reads this to decide when to load the skill'
            : undefined
        }
        hint="Only the name and description go in the system prompt."
      >
        <Textarea
          rows={2}
          prose
          value={inline.description}
          onChange={(event: ChangeEvent<HTMLTextAreaElement>) => set({ description: event.target.value })}
        />
      </Field>
      <Field
        id="node-skill-content"
        label="Content"
        required
        error={blank(inline.content) ? "Write the skill's instructions" : undefined}
        hint="Markdown. Loaded when the model calls load_skill."
      >
        <Textarea
          rows={14}
          value={inline.content}
          onChange={(event: ChangeEvent<HTMLTextAreaElement>) => set({ content: event.target.value })}
        />
      </Field>
    </>
  );
}

/** The skill Inspector described above. */
export function SkillFields({ node, patch, replace }: KindFieldsProps<'skill'>): JSX.Element {
  const { item } = node.data;
  const source = sourceOf(item);
  const onSource = (next: SkillSource | undefined) => {
    if (next === undefined || next === source) return;
    if (next === 'dir') replace({ item: { dir: '' } });
    else if (next === 'registry') replace({ item: { registry: '' } });
    else {
      replace({
        item: { inline: { name: inlineSeedName(item), description: '', content: '' } },
      });
    }
  };
  return (
    <>
      <ChoiceField
        id="node-skill-source"
        label="Source"
        value={source}
        options={SOURCE_OPTIONS}
        onChange={onSource}
      />
      {source === 'dir' && 'dir' in item && <DirForm item={item} patch={patch} />}
      {source === 'registry' && 'registry' in item && <RegistryForm item={item} patch={patch} />}
      {source === 'inline' && 'inline' in item && <InlineForm item={item} patch={patch} />}
    </>
  );
}
