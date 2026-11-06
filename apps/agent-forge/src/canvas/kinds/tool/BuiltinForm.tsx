/**
 * The `{ builtin }` form of the tool Inspector: the catalog picker for the
 * tool name and a JSON field for the built-in's `options`.
 */
import { JsonField } from '../../fields/JsonField';
import { ToolCatalogPicker } from './ToolCatalogPicker';
import { checkJsonObject } from './toolForm';
import type { FormItem } from './toolForm';
import type { KindFieldsProps } from '../index';

/** Props every per-form sub-form takes: the narrowed `item` plus `patch`. */
export interface ToolSubFormProps<F extends keyof FormItemMap> {
  item: FormItemMap[F];
  patch: KindFieldsProps<'tool'>['patch'];
}

/** The `ToolRef` union member per form name (used by `ToolSubFormProps`). */
export interface FormItemMap {
  builtin: FormItem<'builtin'>;
  registry: FormItem<'registry'>;
  file: FormItem<'file'>;
  integration: FormItem<'integration'>;
  openapi: FormItem<'openapi'>;
  hosted: FormItem<'hosted'>;
  hub: FormItem<'hub'>;
}

/** The `{ builtin }` sub-form described above. */
export function BuiltinForm({ item, patch }: ToolSubFormProps<'builtin'>): JSX.Element {
  return (
    <>
      <ToolCatalogPicker
        id="node-tool-builtin"
        value={item.builtin}
        onChange={(builtin) => patch({ builtin })}
      />
      <JsonField
        id="node-tool-options"
        label="Options"
        rows={4}
        value={item.options}
        onChange={(options) => patch({ options })}
        check={checkJsonObject}
        help="Most built-ins need none."
      />
    </>
  );
}
