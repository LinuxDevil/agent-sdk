/**
 * The `guardrail` kind's Inspector body: the built-in picker (changing it
 * deletes `options` — the option schemas are strict per name, so yesterday's
 * keys cannot stay), the checked sides, the run-in-parallel switch, the trip
 * behaviour, the options form rendered from the catalog entry's
 * `optionsJsonSchema` (skeleton rows while the catalog loads, a JSON field
 * when it fails) and the item id. Everything patches `data.item`.
 */
import type { ChangeEvent } from 'react';
import { Field } from '../../../ui/Field';
import { Input, Select, Switch, type SelectOption } from '../../../ui/controls';
import { SkeletonRows } from '../../../ui/Skeleton';
import { SchemaForm } from '../../../ui/schemaForm/SchemaForm';
import type { JsonSchema } from '../../../ui/schemaForm/types';
import {
  allGuardrailIds,
  GUARDRAIL_ID_PATTERN,
  PARALLEL_GUARDRAILS,
} from '../../../graph/v2/kinds/guardrail';
import { guardrailSidesOf, REWRITABLE_GUARDRAILS } from '../../../graph/v2/specTypes';
import type { CatalogGuardrail } from '../../../../shared/wireTypes';
import type { Graph, GuardrailNodeData, NodeOfKind } from '../../../graph/v2/types';
import { ChoiceField } from '../../fields/ChoiceField';
import { JsonField } from '../../fields/JsonField';
import { useCatalog } from '../../useCatalog';
import type { KindFieldsProps } from '../index';

type Patch = KindFieldsProps<'guardrail'>['patch'];

/** The sides the Checks field offers; 'both' writes the explicit `['input', 'output']` list. */
type SideChoice = 'input' | 'output' | 'both';

const PARALLEL_TITLE = 'Only prompt-injection and moderation can run in parallel, on input';

/** The title on the always-disabled Warn option: the SDK has no warn mechanism (`onTripped` accepts it but rejects it). */
const WARN_TITLE = "'warn' is not supported; use 'block' or 'rewrite'";

/** The title on Rewrite while a parallel check is on (the SDK forbids a parallel rewrite). */
const PARALLEL_REWRITE_TITLE = 'A parallel check cannot rewrite';

/** The title on Rewrite for a built-in whose options take no `action` (the SDK's REWRITABLE_GUARDRAILS). */
const REWRITE_TITLE = 'This guardrail cannot rewrite';

/**
 * The When-it-trips options. 'warn' stays listed but disabled — the SDK
 * parses `onTripped: 'warn'` and then rejects it, so offering it would let
 * a user author a spec that cannot save. 'rewrite' is enabled only for the
 * catalog entry's `canRewrite` built-ins (the SDK's rewritable set when the
 * catalog has not answered) and never while the check runs in parallel.
 */
function trippedOptions(parallel: boolean, canRewrite: boolean) {
  return [
    { value: 'block', label: 'Block the run' },
    { value: 'warn', label: 'Warn only', disabled: true, title: WARN_TITLE },
    {
      value: 'rewrite',
      label: 'Rewrite the text',
      disabled: parallel || !canRewrite,
      title: parallel ? PARALLEL_REWRITE_TITLE : canRewrite ? undefined : REWRITE_TITLE,
    },
  ] as const;
}

/**
 * The Checks field's current value: 'both' for the input+output default,
 * 'input'/'output' for the single sides, `undefined` for a side set the
 * canvas cannot pick (a `tools`-only entry shows a blank select rather than
 * a wrong side).
 */
function sideChoice(item: GuardrailNodeData['item']): SideChoice | undefined {
  const sides = guardrailSidesOf(item);
  if (sides.includes('input') && sides.includes('output')) return 'both';
  if (sides.includes('input')) return 'input';
  if (sides.includes('output')) return 'output';
  return undefined;
}

/** One Checks option; a side the catalog entry cannot check is disabled and says why. */
function sideOption(value: SideChoice, allowed: boolean) {
  const label = value === 'both' ? 'Both' : value === 'input' ? 'Input' : 'Output';
  return allowed
    ? { value, label }
    : { value, label, disabled: true, title: `This guardrail cannot check ${value}` };
}

/** The Checks options for the picked catalog entry (all enabled while the entry is unknown). */
function sideOptions(entry: CatalogGuardrail | undefined) {
  const on = entry?.on;
  const input = on === undefined || on.includes('input');
  const output = on === undefined || on.includes('output');
  return [sideOption('input', input), sideOption('output', output), sideOption('both', input && output)];
}

/** The Guardrail select's options: every catalog name, titled by its description, plus an off-catalog current value. */
function nameOptions(item: GuardrailNodeData['item'], entries: CatalogGuardrail[] | undefined, entry: CatalogGuardrail | undefined): SelectOption[] {
  const options: SelectOption[] = (entries ?? []).map((e) => ({
    value: e.name,
    label: e.name,
    title: e.description,
  }));
  const name = item.name as string;
  if (name !== '' && entry === undefined) options.unshift({ value: name, label: name });
  return options;
}

/** The id field's error: empty, outside the spec pattern, or used by another guardrail. */
function idError(node: NodeOfKind<'guardrail'>, graph: Graph): string | undefined {
  const id = node.data.item.id;
  if (id === '') return 'The guardrail needs an id';
  if (!GUARDRAIL_ID_PATTERN.test(id)) {
    return 'The id can use letters, digits, dot, dash or underscore';
  }
  return allGuardrailIds(graph).filter((other) => other === id).length > 1
    ? 'Another guardrail uses this id'
    : undefined;
}

/** The SchemaForm `errors` map: this node's problems that sit under `.options.`, keyed by the remaining path. */
function optionErrors(node: NodeOfKind<'guardrail'>, problems: KindFieldsProps<'guardrail'>['problems']) {
  const prefix = 'options.';
  const errors: Record<string, string> = {};
  for (const problem of problems) {
    if (problem.nodeId !== node.id || problem.fieldPath === undefined) continue;
    const index = problem.fieldPath.indexOf(`.${prefix}`);
    if (index !== -1) errors[problem.fieldPath.slice(index + prefix.length + 1)] = problem.message;
  }
  return errors;
}

/** `check` for the JSON fallback: options are a plain object. */
function optionsObjectOk(value: unknown): string | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? undefined
    : 'Options are a JSON object';
}

/** The Options area: skeleton while the catalog loads, JSON field on error, schema form for the picked entry. */
function OptionsArea({
  item,
  node,
  problems,
  patch,
  entry,
  loading,
  error,
}: {
  item: GuardrailNodeData['item'];
  node: NodeOfKind<'guardrail'>;
  problems: KindFieldsProps<'guardrail'>['problems'];
  patch: Patch;
  entry: CatalogGuardrail | undefined;
  loading: boolean;
  error: string | undefined;
}): JSX.Element {
  if (loading) {
    return (
      <Field label="Options">
        <SkeletonRows rows={3} />
      </Field>
    );
  }
  if (error !== undefined) {
    return (
      <JsonField
        id="node-guard-opt"
        label="Options"
        value={item.options}
        onChange={(options) => patch({ options })}
        check={optionsObjectOk}
        help="The catalog is unavailable; edit the options as JSON."
      />
    );
  }
  if (entry === undefined) return <></>;
  const onOptions = (next: unknown) => {
    const empty = typeof next === 'object' && next !== null && Object.keys(next).length === 0;
    patch({ options: empty ? undefined : next });
  };
  return (
    <Field label="Options">
      <SchemaForm
        schema={entry.optionsJsonSchema as JsonSchema}
        value={item.options ?? {}}
        onChange={onOptions}
        idPrefix="node-guard-opt"
        errors={optionErrors(node, problems)}
      />
    </Field>
  );
}

/** The guardrail Inspector described above. */
export function GuardrailFields({ node, graph, patch, problems }: KindFieldsProps<'guardrail'>): JSX.Element {
  const { item } = node.data;
  const catalog = useCatalog('guardrails');
  const entry = catalog.data?.find((e) => e.name === item.name);
  const name = item.name as string;
  const parallel = item.runInParallel === true;
  const side = sideChoice(item);
  const parallelAllowed =
    (PARALLEL_GUARDRAILS as readonly string[]).includes(name) &&
    guardrailSidesOf(item).includes('input') &&
    entry?.canRunInParallel !== false;
  // The catalog's `canRewrite` is the SDK's REWRITABLE_GUARDRAILS membership; fall back to the set itself while the catalog is unanswered.
  const canRewrite = entry?.canRewrite ?? (REWRITABLE_GUARDRAILS as readonly string[]).includes(name);
  return (
    <>
      <Field
        id="node-guard-name"
        label="Guardrail"
        required
        error={name === '' ? 'Pick a guardrail' : undefined}
        hint={entry?.description}
      >
        <Select
          options={nameOptions(item, catalog.data, entry)}
          placeholder="Pick a guardrail"
          value={name}
          onChange={(event: ChangeEvent<HTMLSelectElement>) =>
            patch({ name: event.target.value, options: undefined })
          }
        />
      </Field>
      <ChoiceField
        id="node-guard-on"
        label="Checks"
        value={side}
        options={sideOptions(entry)}
        onChange={(next) => patch({ on: next === 'both' ? ['input', 'output'] : next })}
        help={
          side === undefined
            ? 'This guardrail checks the tools side, which this editor cannot change.'
            : undefined
        }
      />
      <Field
        id="node-guard-parallel"
        label="Run in parallel"
        inline
        hint="Checks while the first model call runs. It can block but not rewrite."
      >
        <Switch
          checked={parallel}
          disabled={!parallelAllowed}
          title={parallelAllowed ? undefined : PARALLEL_TITLE}
          onChange={(on) => patch({ runInParallel: on ? true : undefined })}
        />
      </Field>
      <ChoiceField
        id="node-guard-tripped"
        label="When it trips"
        value={item.onTripped}
        allowUnset
        unsetLabel="Default"
        options={[...trippedOptions(parallel, canRewrite)]}
        onChange={(onTripped) => patch({ onTripped })}
      />
      <OptionsArea
        item={item}
        node={node}
        problems={problems}
        patch={patch}
        entry={entry}
        loading={catalog.loading}
        error={catalog.error}
      />
      <Field id="node-guard-id" label="Id" required error={idError(node, graph)} hint="Used in traces and node ids.">
        <Input
          value={item.id}
          onChange={(event: ChangeEvent<HTMLInputElement>) => patch({ id: event.target.value })}
        />
      </Field>
    </>
  );
}
