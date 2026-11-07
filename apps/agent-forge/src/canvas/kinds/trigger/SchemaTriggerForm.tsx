/**
 * `SchemaTriggerForm` — the Inspector body for a catalog trigger type
 * outside the five PLAN kinds (chat, cron, webhook, channel, agent): U13's
 * `SchemaForm` over the catalog row's `fieldsJsonSchema`, editing the
 * item's keys minus `id` and `type` and writing them back around those
 * two. A field the schema cannot draw falls back to a JSON textarea.
 */
import { SchemaForm } from '../../../ui/schemaForm/SchemaForm';
import type { JsonSchema } from '../../../ui/schemaForm/types';
import type { CatalogTriggerType } from '../../../../shared/wireTypes';
import type { TriggerSpec } from '../../../graph/v2/specTypes';
import type { KindFieldsProps } from '../index';

/** Props for {@link SchemaTriggerForm}. */
export interface SchemaTriggerFormProps {
  /** The catalog row of the item's type — supplies `fieldsJsonSchema`. */
  info: CatalogTriggerType;
  item: TriggerSpec;
  /** `setNodeData` through the Inspector — the schema form rewrites `item` whole. */
  replace: KindFieldsProps<'trigger'>['replace'];
}

/** The schema-form trigger described above. */
export function SchemaTriggerForm({ info, item, replace }: SchemaTriggerFormProps): JSX.Element {
  const { id, type, ...fields } = item as TriggerSpec & Record<string, unknown>;
  return (
    <SchemaForm
      schema={info.fieldsJsonSchema as JsonSchema}
      value={fields}
      onChange={(next) =>
        replace({ item: { id, type, ...(next as Record<string, unknown>) } as unknown as TriggerSpec })
      }
      idPrefix="node-trigger"
    />
  );
}
