/**
 * The `webhook` trigger's Inspector sub-form: the path (mono input
 * flagged by `WEBHOOK_PATH_PATTERN`), the HMAC signing secret as a
 * `SecretRefField` without plain-text mode, the required prompt template
 * the request body fills and the optional `filter` safeExpression.
 */
import type { ChangeEvent } from 'react';
import { Field } from '../../../ui/Field';
import { Input, Textarea } from '../../../ui/controls';
import { WEBHOOK_PATH_PATTERN } from '../../../graph/v2/kinds/trigger';
import type { TriggerSpec } from '../../../graph/v2/specTypes';
import { SecretRefField } from '../../fields/SecretRefField';
import type { TriggerSubFormProps } from './CronForm';

const PATH_ERROR = 'Start with / and use letters, digits, dash or underscore';
const TEMPLATE_ERROR = 'Enter a prompt template';

/** The `webhook` sub-form described above. */
export function WebhookForm({
  item,
  patch,
}: TriggerSubFormProps<Extract<TriggerSpec, { type: 'webhook' }>>): JSX.Element {
  return (
    <>
      <Field
        id="node-trigger-path"
        label="Path"
        required
        error={WEBHOOK_PATH_PATTERN.test(item.path) ? undefined : PATH_ERROR}
        hint="Called as POST <studio>/<path>."
      >
        <Input
          className="input-mono"
          value={item.path}
          onChange={(event: ChangeEvent<HTMLInputElement>) => patch({ path: event.target.value })}
        />
      </Field>
      <SecretRefField
        id="node-trigger-secret"
        label="Signing secret"
        value={item.secret}
        onChange={(secret) => patch({ secret })}
        help="Requests without a valid HMAC signature are rejected."
      />
      <Field
        id="node-trigger-prompt-template"
        label="Prompt template"
        required
        error={item.promptTemplate.trim() === '' ? TEMPLATE_ERROR : undefined}
        hint="Variables like {{event.body.subject}} come from the request body."
      >
        <Textarea
          rows={3}
          value={item.promptTemplate}
          onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
            patch({ promptTemplate: event.target.value })
          }
        />
      </Field>
      <Field
        id="node-trigger-filter"
        label="Filter"
        hint="Optional expression; the run starts only when it is true."
      >
        <Input
          className="input-mono"
          value={item.filter ?? ''}
          onChange={(event: ChangeEvent<HTMLInputElement>) =>
            patch({ filter: event.target.value === '' ? undefined : event.target.value })
          }
        />
      </Field>
    </>
  );
}
