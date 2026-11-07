/**
 * The Instructions section of the agent Inspector (C03): a Text/File
 * source toggle over `fields.instructions` (each side keeps its draft
 * while the other is shown, so Text → File → Text restores the typed
 * prompt), the registry `promptRef` input and the per-family
 * `instructionsByFamily` map.
 */
import { useEffect, useState, type ChangeEvent } from 'react';
import type { SecretRef } from '../../../../shared/wireTypes';
import type { AgentFields } from '../../../graph/v2/types';
import type { KindFieldsProps } from '../index';
import { Field } from '../../../ui/Field';
import { Input, Textarea } from '../../../ui/controls';
import { ChoiceField } from '../../fields/ChoiceField';
import { KeyValueField } from '../../fields/KeyValueField';

/** The `name@label` shape of a prompt-registry ref. */
const PROMPT_REF_PATTERN = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/;
const PROMPT_REF_ERROR = 'Use name@label, e.g. triage@prod';
const FILE_PATH_ERROR = 'Use a path inside the agent folder';

type Source = 'text' | 'file';

const SOURCE_OPTIONS: { value: Source; label: string }[] = [
  { value: 'text', label: 'Text' },
  { value: 'file', label: 'File' },
];

/** The draft the file side starts with when `instructions` has no file form yet. */
function fileOf(instructions: AgentFields['instructions']): string {
  return typeof instructions === 'object' && instructions !== null && typeof instructions.file === 'string'
    ? instructions.file
    : '';
}

/** The draft the text side starts with when `instructions` has no text form yet. */
function textOf(instructions: AgentFields['instructions']): string {
  return typeof instructions === 'string' ? instructions : '';
}

/** A file path that stays inside the agent folder: never absolute, never `..`. */
function badPath(path: string): boolean {
  return path.startsWith('/') || path.includes('..');
}

/** The editor for the active source: a 12-row textarea for text, a path input for file. */
function SourceEditor({
  source,
  instructions,
  onText,
  onFile,
}: {
  source: Source;
  instructions: AgentFields['instructions'];
  onText: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  onFile: (event: ChangeEvent<HTMLInputElement>) => void;
}): JSX.Element {
  if (source === 'text') {
    const text = textOf(instructions);
    return (
      <Field
        id="node-agent-instructions"
        label="Instructions"
        required
        error={text.trim() === '' ? 'Required' : undefined}
        hint="The system prompt."
      >
        <Textarea value={text} onChange={onText} rows={12} spellCheck={false} />
      </Field>
    );
  }
  const filePath = fileOf(instructions);
  return (
    <Field
      id="node-agent-instructions-file"
      label="Instructions"
      required
      error={filePath === '' ? 'Required' : badPath(filePath) ? FILE_PATH_ERROR : undefined}
      hint="Path relative to the agent folder, e.g. prompts/main.md."
    >
      <Input value={filePath} onChange={onFile} placeholder="prompts/main.md" />
    </Field>
  );
}

/** The instructions editor described above. */
export function InstructionsField({
  node,
  patch,
}: Pick<KindFieldsProps<'agent'>, 'node' | 'patch'>): JSX.Element {
  const { fields } = node.data;
  const instructions = fields.instructions;
  const source: Source = typeof instructions === 'object' && instructions !== null ? 'file' : 'text';
  const [textDraft, setTextDraft] = useState(() => textOf(instructions));
  const [fileDraft, setFileDraft] = useState(() => fileOf(instructions));
  // Sync only the side `instructions` currently holds: the other side keeps
  // what was last typed, so Text → File → Text restores it.
  useEffect(() => {
    if (typeof instructions === 'string') setTextDraft(instructions);
    else if (typeof instructions === 'object' && instructions !== null && typeof instructions.file === 'string') {
      setFileDraft(instructions.file);
    }
  }, [instructions]);

  const onSource = (next: Source | undefined) => {
    if (next === 'file') patch({ instructions: { file: fileDraft } });
    else if (next === 'text') patch({ instructions: textDraft });
  };

  const onText = (event: ChangeEvent<HTMLTextAreaElement>) => {
    setTextDraft(event.target.value);
    patch({ instructions: event.target.value });
  };
  const onFile = (event: ChangeEvent<HTMLInputElement>) => {
    setFileDraft(event.target.value);
    patch({ instructions: { file: event.target.value } });
  };
  const onPromptRef = (event: ChangeEvent<HTMLInputElement>) =>
    patch({ promptRef: event.target.value === '' ? undefined : event.target.value });
  const onByFamily = (value: Record<string, string | SecretRef> | undefined) =>
    patch({ instructionsByFamily: value as AgentFields['instructionsByFamily'] });

  const promptRef = fields.promptRef ?? '';

  return (
    <>
      <ChoiceField<Source>
        id="node-agent-instructions-source"
        label="Source"
        value={source}
        options={SOURCE_OPTIONS}
        onChange={onSource}
      />
      <SourceEditor source={source} instructions={instructions} onText={onText} onFile={onFile} />
      <Field
        id="node-agent-prompt-ref"
        label="Prompt from registry"
        error={promptRef !== '' && !PROMPT_REF_PATTERN.test(promptRef) ? PROMPT_REF_ERROR : undefined}
        hint="When set, the registry prompt is used and the text above is the fallback."
      >
        <Input value={promptRef} onChange={onPromptRef} placeholder="triage@prod" />
      </Field>
      <KeyValueField
        id="node-agent-by-family"
        label="Per model family"
        value={fields.instructionsByFamily}
        onChange={onByFamily}
        valueKind="text"
        emptyKeyError="Each row needs a family name"
        help="Appended when the model id contains the name, e.g. claude."
      />
    </>
  );
}
