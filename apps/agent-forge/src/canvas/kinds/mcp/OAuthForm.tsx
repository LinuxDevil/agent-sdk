/**
 * The OAuth block of the http MCP form: the "Sign in with OAuth" switch
 * (on = `item.oauth: { redirectUri: '' }`) plus redirect URI, client id,
 * client secret (a SecretRef — never a plain value) and scopes.
 */
import type { ChangeEvent } from 'react';
import { Field } from '../../../ui/Field';
import { Input, Switch } from '../../../ui/controls';
import type { SecretRef } from '../../../../shared/wireTypes';
import { SecretRefField } from '../../fields/SecretRefField';
import { StringListField } from '../../fields/StringListField';
import type { KindFieldsProps } from '../index';
import type { McpOAuthItem } from './mcpItem';

/** Props for {@link OAuthForm}: `item.oauth` plus `patch`. */
export interface OAuthFormProps {
  oauth: McpOAuthItem | undefined;
  patch: KindFieldsProps<'mcp'>['patch'];
}

/** The OAuth fields described above; the sub-fields render only while the switch is on. */
export function OAuthForm({ oauth, patch }: OAuthFormProps): JSX.Element {
  /**
   * `oauth` merged with `delta`: `undefined` and `''` values delete their
   * key, and an emptied object falls back to `{ redirectUri: '' }` so the
   * switch stays on while the user is still editing.
   */
  const patchOauth = (delta: Partial<McpOAuthItem>): void => {
    const next = { ...(oauth ?? { redirectUri: '' }), ...delta } as Record<string, unknown>;
    for (const key of Object.keys(next)) {
      if (next[key] === undefined || next[key] === '') delete next[key];
    }
    patch({ oauth: Object.keys(next).length === 0 ? { redirectUri: '' } : next });
  };
  return (
    <>
      <Field
        id="node-mcp-oauth"
        label="Sign in with OAuth"
        inline
        hint="The operator signs in once; the grant is stored by Studio."
      >
        <Switch
          checked={oauth !== undefined}
          onChange={(on) => patch({ oauth: on ? { redirectUri: '' } : undefined })}
        />
      </Field>
      {oauth !== undefined && (
        <>
          <Field
            id="node-mcp-oauth-redirect"
            label="Redirect URI"
            required
            error={oauth.redirectUri === '' ? 'OAuth needs a redirect URI' : undefined}
          >
            <Input
              type="url"
              value={oauth.redirectUri}
              onChange={(event: ChangeEvent<HTMLInputElement>) => patchOauth({ redirectUri: event.target.value })}
            />
          </Field>
          <Field
            id="node-mcp-oauth-client-id"
            label="Client id"
            hint="Leave empty to register automatically."
          >
            <Input
              value={oauth.clientId ?? ''}
              onChange={(event: ChangeEvent<HTMLInputElement>) => patchOauth({ clientId: event.target.value })}
            />
          </Field>
          <SecretRefField
            id="node-mcp-oauth-client-secret"
            label="Client secret"
            value={oauth.clientSecret as SecretRef | string | undefined}
            onChange={(clientSecret) => patchOauth({ clientSecret: clientSecret as McpOAuthItem['clientSecret'] })}
          />
          {oauth.clientSecret !== undefined && (oauth.clientId === undefined || oauth.clientId === '') && (
            <p className="hint field-error">Set the client id first</p>
          )}
          <StringListField
            id="node-mcp-oauth-scopes"
            label="Scopes"
            value={oauth.scopes as string[] | undefined}
            onChange={(scopes) => patchOauth({ scopes })}
          />
        </>
      )}
    </>
  );
}
