/**
 * The `subagent` kind's Inspector body (C04): the record key, a Source
 * toggle between "Agent in this workspace" (`{ ref }`) and "Remote agent"
 * (`{ remote }`), then the ref picker (workspace agents as
 * `agents/<id>.yaml` plus a free "Other path…" input) or the remote's URL,
 * description and bearer-secret field. Key edits go through `replace`
 * (the key sits outside `item`); everything else patches `data.item`.
 */
import type { ChangeEvent } from 'react';
import { useAppState } from '../../../state/AppState';
import { Field } from '../../../ui/Field';
import { Input, Select, Textarea } from '../../../ui/controls';
import { remoteUrlOk, SUBAGENT_KEY_PATTERN } from '../../../graph/v2/kinds/subagent';
import { subagentEntryKey } from '../../../graph/v2/order';
import type { SecretRef } from '../../../graph/v2/specTypes';
import type { NodeOfKind, SubagentNodeData } from '../../../graph/v2/types';
import { ChoiceField } from '../../fields/ChoiceField';
import { SecretRefField } from '../../fields/SecretRefField';
import type { KindFieldsProps } from '../index';

const KEY_PATTERN_ERROR = 'Use lower-case letters, digits, dash or underscore';
const KEY_TAKEN_ERROR = 'Another subagent already uses this name';
const OTHER_PATH = '__other';

/** The inline error for `data.key`, or `undefined`. */
function keyError(node: NodeOfKind<'subagent'>, graph: KindFieldsProps<'subagent'>['graph']): string | undefined {
  const key = node.data.key;
  if (key === '') return 'Required';
  if (!SUBAGENT_KEY_PATTERN.test(key)) return KEY_PATTERN_ERROR;
  const taken = graph.nodes.some(
    (n) => n.id !== node.id && n.owner === node.owner && n.proposed !== 'remove' && subagentEntryKey(n) === key,
  );
  return taken ? KEY_TAKEN_ERROR : undefined;
}

/** `ref === ''` asks for the workspace picker; anything else is a valid (or free) path. */
function refError(ref: string): string | undefined {
  return ref === '' ? 'Pick an agent' : undefined;
}

/** The workspace picker + free-path input for a `{ ref }` item. */
function RefFields({ node, patch }: Pick<KindFieldsProps<'subagent'>, 'node' | 'patch'>): JSX.Element {
  const { agents, agentId } = useAppState();
  const ref = 'ref' in node.data.item ? node.data.item.ref : '';
  const options = agents
    .filter((agent) => agent.id !== agentId)
    .map((agent) => ({ value: `agents/${agent.id}.yaml`, label: agent.name || agent.id }));
  const known = options.some((option) => option.value === ref);
  return (
    <>
      <Field
        id="node-subagent-ref"
        label="Agent"
        required
        error={refError(ref)}
        hint="Runs that agent's working copy as a subagent."
      >
        <Select
          options={[...options, { value: OTHER_PATH, label: 'Other path…' }]}
          value={known ? ref : OTHER_PATH}
          onChange={(event: ChangeEvent<HTMLSelectElement>) => {
            // "Other path…" clears the ref so `known` goes false and the free-path input appears.
            patch({ ref: event.target.value === OTHER_PATH ? '' : event.target.value });
          }}
        />
      </Field>
      {!known && (
        <Field id="node-subagent-ref-path" label="Agent path" hint="A path under the agent folder, e.g. shared/helper.yaml.">
          <Input value={ref} onChange={(event: ChangeEvent<HTMLInputElement>) => patch({ ref: event.target.value })} />
        </Field>
      )}
    </>
  );
}

type RemoteItem = Extract<SubagentNodeData['item'], { remote: unknown }>['remote'];

/** The URL, description and bearer-auth fields for a `{ remote }` item. */
function RemoteFields({ remote, patch }: { remote: RemoteItem; patch: KindFieldsProps<'subagent'>['patch'] }): JSX.Element {
  const setRemote = (remotePatch: Partial<RemoteItem>) => patch({ remote: { ...remote, ...remotePatch } });
  const onAuth = (auth: SecretRef | string | undefined) => {
    // SecretRefField can emit a plain string only with allowPlain (absent
    // here), but its onChange type allows one — drop it rather than write
    // a shape the spec does not carry.
    const next: RemoteItem = { url: remote.url, description: remote.description };
    if (auth !== undefined && typeof auth !== 'string') next.auth = auth;
    patch({ remote: next });
  };
  return (
    <>
      <Field
        id="node-subagent-url"
        label="URL"
        required
        error={remoteUrlOk(remote.url) ? undefined : 'Enter a full URL starting with https://'}
      >
        <Input
          type="url"
          value={remote.url}
          onChange={(event: ChangeEvent<HTMLInputElement>) => setRemote({ url: event.target.value })}
        />
      </Field>
      <Field
        id="node-subagent-description"
        label="Description"
        required
        error={remote.description.trim() === '' ? 'A remote agent needs a description' : undefined}
        hint="Tells the main agent when to delegate."
      >
        <Textarea
          rows={2}
          value={remote.description}
          onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setRemote({ description: event.target.value })}
        />
      </Field>
      <SecretRefField id="node-subagent-auth" label="Auth" value={remote.auth} onChange={onAuth} help="Sent as a bearer token." />
    </>
  );
}

/** The subagent Inspector: name, source, then the ref picker or the remote fields. */
export function SubagentFields({ node, graph, patch, replace }: KindFieldsProps<'subagent'>): JSX.Element {
  const item = node.data.item;
  const isRemote = 'remote' in item;
  const onSource = (source: 'ref' | 'remote' | undefined) => {
    if (source === undefined || isRemote === (source === 'remote')) return;
    replace({
      ...node.data,
      item: source === 'remote' ? { remote: { url: '', description: '' } } : { ref: '' },
    });
  };
  return (
    <>
      <Field
        id="node-subagent-key"
        label="Name"
        required
        error={keyError(node, graph)}
        hint="The main agent delegates to it by this name."
      >
        <Input
          value={node.data.key}
          onChange={(event: ChangeEvent<HTMLInputElement>) => replace({ ...node.data, key: event.target.value })}
        />
      </Field>
      <ChoiceField
        id="node-subagent-source"
        label="Source"
        value={isRemote ? 'remote' : 'ref'}
        options={[
          { value: 'ref', label: 'Agent in this workspace' },
          { value: 'remote', label: 'Remote agent' },
        ]}
        onChange={onSource}
      />
      {isRemote ? (
        <RemoteFields remote={item.remote} patch={patch} />
      ) : (
        <RefFields node={node} patch={patch} />
      )}
    </>
  );
}
