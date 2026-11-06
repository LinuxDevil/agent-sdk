/**
 * The `{ openapi }` form of the tool Inspector: the document URL, the
 * include/exclude operation lists, the per-call approval level and the
 * bearer token — all nested under `item.openapi`, so writes rebuild the
 * object (an `undefined` member deletes that key).
 */
import type { ChangeEvent } from 'react';
import { Field } from '../../../ui/Field';
import { Input } from '../../../ui/controls';
import { fullUrlOk } from '../../../graph/v2/kinds/tool';
import type { OpenApiToolRefOptions } from '../../../graph/v2/specTypes';
import { ChoiceField } from '../../fields/ChoiceField';
import { SecretRefField } from '../../fields/SecretRefField';
import { StringListField } from '../../fields/StringListField';
import type { ToolSubFormProps } from './BuiltinForm';

type Approval = NonNullable<OpenApiToolRefOptions['approval']>;

/** The `{ openapi }` sub-form described above. */
export function OpenApiForm({ item, patch }: ToolSubFormProps<'openapi'>): JSX.Element {
  const openapi = item.openapi;
  /** Shallow-merges `p` into `item.openapi`; `undefined` members delete the key. */
  const set = (p: Partial<OpenApiToolRefOptions>) => {
    const next: Partial<OpenApiToolRefOptions> = { ...openapi, ...p };
    for (const key of Object.keys(next) as (keyof OpenApiToolRefOptions)[]) {
      if (next[key] === undefined) delete next[key];
    }
    patch({ openapi: next });
  };
  return (
    <>
      <Field
        id="node-tool-openapi-url"
        label="Spec URL"
        required
        error={fullUrlOk(openapi.url) ? undefined : 'Enter the OpenAPI document URL'}
      >
        <Input
          type="url"
          value={openapi.url}
          onChange={(event: ChangeEvent<HTMLInputElement>) => set({ url: event.target.value })}
        />
      </Field>
      <StringListField
        id="node-tool-include"
        label="Only these operations"
        value={openapi.include}
        onChange={(include) => set({ include })}
        help="Operation ids. Empty means all."
      />
      <StringListField
        id="node-tool-exclude"
        label="Skip these operations"
        value={openapi.exclude}
        onChange={(exclude) => set({ exclude })}
      />
      <ChoiceField
        id="node-tool-openapi-approval"
        label="Ask before"
        value={openapi.approval}
        allowUnset
        options={[
          { value: 'mutating' as Approval, label: 'Calls that change data' },
          { value: 'always' as Approval, label: 'Every call' },
          { value: 'never' as Approval, label: 'Never' },
        ]}
        onChange={(approval) => set({ approval })}
      />
      <SecretRefField
        id="node-tool-bearer"
        label="Bearer token"
        value={openapi.bearerToken}
        onChange={(bearerToken) => set({ bearerToken: typeof bearerToken === 'string' ? undefined : bearerToken })}
      />
    </>
  );
}
