/**
 * The stdio half of the MCP Inspector: command, arguments, environment
 * (secret-capable values, env-var names), working folder and the stderr
 * policy. Renders only while the item is a `{ command }` entry.
 */
import type { ChangeEvent } from 'react';
import { Field } from '../../../ui/Field';
import { Input } from '../../../ui/controls';
import { isSafeRelativePath } from '../../../graph/v2/specTypes';
import { ChoiceField } from '../../fields/ChoiceField';
import { KeyValueField } from '../../fields/KeyValueField';
import { StringListField } from '../../fields/StringListField';
import type { KindFieldsProps } from '../index';
import type { McpStdioItem } from './mcpItem';

/** Props for {@link StdioForm}: the stdio `item` plus `patch`. */
export interface StdioFormProps {
  item: McpStdioItem;
  patch: KindFieldsProps<'mcp'>['patch'];
}

/** Env-var names: `GITHUB_TOKEN`, `PATH`, … */
const ENV_KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

type Stderr = NonNullable<McpStdioItem['stderr']>;

const STDERR_OPTIONS: { value: Stderr; label: string }[] = [
  { value: 'forward', label: 'Forward' },
  { value: 'capture', label: 'Capture' },
  { value: 'inherit', label: 'Inherit' },
  { value: 'ignore', label: 'Ignore' },
];

/** The stdio fields described above. */
export function StdioForm({ item, patch }: StdioFormProps): JSX.Element {
  const cwdError =
    item.cwd !== undefined && item.cwd !== '' && !isSafeRelativePath(item.cwd)
      ? 'Use a relative path inside the agent folder'
      : undefined;
  return (
    <>
      <Field
        id="node-mcp-command"
        label="Command"
        required
        error={item.command.trim() === '' ? 'Enter the command that starts the server' : undefined}
        hint="For example npx or uvx."
      >
        <Input
          value={item.command}
          onChange={(event: ChangeEvent<HTMLInputElement>) => patch({ command: event.target.value })}
        />
      </Field>
      <StringListField
        id="node-mcp-args"
        label="Arguments"
        value={item.args}
        onChange={(args) => patch({ args })}
      />
      <KeyValueField
        id="node-mcp-env"
        label="Environment"
        value={item.env}
        onChange={(env) => patch({ env })}
        valueKind="secret"
        keyPattern={ENV_KEY_PATTERN}
      />
      <Field id="node-mcp-cwd" label="Working folder" error={cwdError}>
        <Input
          value={item.cwd ?? ''}
          onChange={(event: ChangeEvent<HTMLInputElement>) =>
            patch({ cwd: event.target.value === '' ? undefined : event.target.value })
          }
        />
      </Field>
      <ChoiceField
        id="node-mcp-stderr"
        label="Server errors"
        value={item.stderr}
        options={STDERR_OPTIONS}
        onChange={(stderr) => patch({ stderr })}
        allowUnset
      />
    </>
  );
}
