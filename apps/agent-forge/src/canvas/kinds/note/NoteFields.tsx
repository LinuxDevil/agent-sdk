/**
 * The `note` kind's Inspector body: a single textarea for the sticky
 * note's text. Notes are layout data — `patch` writes `data.text`
 * (`patchNode` merges into `data` itself for notes) and `graphToSpec`
 * puts them only in `layout.notes`, never in the agent spec.
 */
import type { ChangeEvent } from 'react';
import { Field } from '../../../ui/Field';
import { Textarea } from '../../../ui/controls';
import type { KindFieldsProps } from '../index';

/** The note Inspector described above. */
export function NoteFields({ node, patch }: KindFieldsProps<'note'>): JSX.Element {
  return (
    <Field
      id="node-note-text"
      label="Note"
      hint="Notes are saved with the layout, not in the agent spec."
    >
      <Textarea
        rows={6}
        prose
        value={node.data.text}
        onChange={(event: ChangeEvent<HTMLTextAreaElement>) => patch({ text: event.target.value })}
      />
    </Field>
  );
}
