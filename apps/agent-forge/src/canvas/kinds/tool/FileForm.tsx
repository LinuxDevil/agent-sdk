/**
 * The `{ file }` form of the tool Inspector: the agentDir-relative path of
 * a tool code file. The field error is `toolFilePathOk`'s rule — the same
 * check the graph validator applies.
 */
import type { ChangeEvent } from 'react';
import { Field } from '../../../ui/Field';
import { Input } from '../../../ui/controls';
import { toolFilePathOk } from '../../../graph/v2/kinds/tool';
import type { ToolSubFormProps } from './BuiltinForm';

/** The `{ file }` sub-form described above. */
export function FileForm({ item, patch }: ToolSubFormProps<'file'>): JSX.Element {
  return (
    <Field
      id="node-tool-file"
      label="Path"
      required
      error={toolFilePathOk(item.file) ? undefined : 'Use a .ts or .js file inside the agent folder'}
    >
      <Input
        value={item.file}
        placeholder="tools/search.ts"
        onChange={(event: ChangeEvent<HTMLInputElement>) => patch({ file: event.target.value })}
      />
    </Field>
  );
}
