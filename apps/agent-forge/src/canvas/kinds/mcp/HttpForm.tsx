/**
 * The http half of the MCP Inspector: the server URL, its headers
 * (secret-capable values) and the OAuth block. Renders only while the item
 * is a `{ url }` entry.
 */
import type { ChangeEvent } from 'react';
import { Field } from '../../../ui/Field';
import { Input } from '../../../ui/controls';
import { fullUrlOk } from '../../../graph/v2/kinds/tool';
import { KeyValueField } from '../../fields/KeyValueField';
import type { KindFieldsProps } from '../index';
import type { McpHttpItem } from './mcpItem';
import { OAuthForm } from './OAuthForm';

/** Props for {@link HttpForm}: the http `item` plus `patch`. */
export interface HttpFormProps {
  item: McpHttpItem;
  patch: KindFieldsProps<'mcp'>['patch'];
}

/** The http fields described above. */
export function HttpForm({ item, patch }: HttpFormProps): JSX.Element {
  return (
    <>
      <Field
        id="node-mcp-url"
        label="URL"
        required
        error={fullUrlOk(item.url) ? undefined : 'Enter the server URL'}
      >
        <Input
          type="url"
          value={item.url}
          onChange={(event: ChangeEvent<HTMLInputElement>) => patch({ url: event.target.value })}
        />
      </Field>
      <KeyValueField
        id="node-mcp-headers"
        label="Headers"
        value={item.headers}
        onChange={(headers) => patch({ headers })}
        valueKind="secret"
        help="Use a secret for Authorization."
      />
      <OAuthForm oauth={item.oauth} patch={patch} />
    </>
  );
}
