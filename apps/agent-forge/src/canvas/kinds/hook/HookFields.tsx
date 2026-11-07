/**
 * The `hook` kind's Inspector body: the Source choice swaps the `HookSpec`
 * variant (keeping only the entry `id`), then the file path or the inline
 * form — name, hook point, the on switch, the sandboxed code body and the
 * starter templates filtered to the current point. The id field edits
 * `item.id` for both variants.
 *
 * The editor only edits text: hook code is never evaluated in the browser —
 * it runs in Studio's server-side sandbox the next time the agent runs.
 */
import type { ChangeEvent } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { allHookIds, HOOK_ID_PATTERN, hookFileOk } from '../../../graph/v2/kinds/hook';
import type { HookSpec, InlineHookSpec } from '../../../graph/v2/specTypes';
import type { Graph, HookNodeData, NodeOfKind } from '../../../graph/v2/types';
import { Field } from '../../../ui/Field';
import { Input, Switch } from '../../../ui/controls';
import { HOOK_TEMPLATES, templatePoint, type HookTemplate } from '../../../hooks/hookTemplates';
import { ChoiceField } from '../../fields/ChoiceField';
import type { KindFieldsProps } from '../index';

/** The `HookSpec` variant the Source choice edits. */
type HookSource = 'inline' | 'file';

type Patch = KindFieldsProps<'hook'>['patch'];

const SOURCE_OPTIONS: { value: HookSource; label: string }[] = [
  { value: 'inline', label: 'Code here' },
  { value: 'file', label: 'File' },
];

const POINT_OPTIONS: { value: InlineHookSpec['point']; label: string }[] = [
  { value: 'preToolCall', label: 'Before each tool call' },
  { value: 'postToolCall', label: 'After each tool call' },
  { value: 'preGenerate', label: 'Before each model call' },
  { value: 'postGenerate', label: 'After each model call' },
];

/** The ctx help under Runs, per point family. */
const POINT_HELP: Record<'tool' | 'model', string> = {
  tool: 'ctx has toolName, args and, after the call, result or error. Return ctx.',
  model: 'ctx has messages and model. Return ctx.',
};

/** Whether `point` runs around a tool call (the `ctx` has `toolName`/`args`) or a model call (`messages`/`model`). */
function pointFamily(point: InlineHookSpec['point']): 'tool' | 'model' {
  return point === 'preToolCall' || point === 'postToolCall' ? 'tool' : 'model';
}

/** The id field's error: empty, outside the spec pattern, or used by another hook. */
function idError(node: NodeOfKind<'hook'>, graph: Graph): string | undefined {
  const id = node.data.item.id;
  if (id === '') return 'The hook needs an id';
  if (!HOOK_ID_PATTERN.test(id)) {
    return 'The id can use letters, digits, dash or underscore';
  }
  return allHookIds(graph).filter((other) => other === id).length > 1
    ? 'Another hook uses this id'
    : undefined;
}

/** The `{ file }` sub-form: a code file inside the agent's folder. */
function FileForm({ item, patch }: { item: { file: string }; patch: Patch }): JSX.Element {
  return (
    <Field
      id="node-hook-file"
      label="File"
      required
      error={hookFileOk(item.file) ? undefined : 'Use a .ts or .js file inside the agent folder'}
      hint="Default-exports a hook or a list of hooks."
    >
      <Input
        value={item.file}
        placeholder="hooks/audit-log.ts"
        onChange={(event: ChangeEvent<HTMLInputElement>) => patch({ file: event.target.value })}
      />
    </Field>
  );
}

/** Applies `template`: replaces `code` (after a confirm when it is non-empty) and `name` while it is still the default 'hook'. */
function applyTemplate(inline: InlineHookSpec, set: (part: Partial<InlineHookSpec>) => void, template: HookTemplate): void {
  if (inline.code !== '' && !window.confirm(`Replace the current code with ${template.name}?`)) {
    return;
  }
  set({ code: template.code, ...(inline.name === 'hook' ? { name: template.name } : {}) });
}

/**
 * The `{ inline }` sub-form: name, Runs, the On switch, the CodeMirror code
 * body and the template buttons. `set` shallow-merges into `item.inline`;
 * switching On back on deletes the `enabled` key rather than writing `true`.
 */
function InlineForm({ item, patch }: { item: HookNodeData['item']; patch: Patch }): JSX.Element {
  const inline = (item as Extract<HookSpec, { inline: InlineHookSpec }>).inline;
  const set = (part: Partial<InlineHookSpec>) => patch({ inline: { ...inline, ...part } });
  const onToggle = (on: boolean) => {
    if (!on) {
      set({ enabled: false });
      return;
    }
    const next = { ...inline };
    delete next.enabled;
    patch({ inline: next });
  };
  const templates = HOOK_TEMPLATES.filter((t) => templatePoint(t) === inline.point);
  return (
    <>
      <Field
        id="node-hook-name"
        label="Name"
        required
        error={inline.name.trim() === '' ? 'The hook needs a name' : undefined}
      >
        <Input
          value={inline.name}
          onChange={(event: ChangeEvent<HTMLInputElement>) => set({ name: event.target.value })}
        />
      </Field>
      <ChoiceField
        id="node-hook-point"
        label="Runs"
        value={inline.point}
        options={POINT_OPTIONS}
        onChange={(point) => {
          if (point !== undefined) set({ point });
        }}
        help={POINT_HELP[pointFamily(inline.point)]}
      />
      <Field
        id="node-hook-enabled"
        label="On"
        inline
        hint="A hook that is off stays in the file but does not run."
      >
        <Switch checked={inline.enabled !== false} onChange={onToggle} />
      </Field>
      <Field
        id="node-hook-code"
        label="Code"
        hint="The body of an async function. It runs in Studio's sandbox, not in your browser."
      >
        <div className="hook-code">
          <CodeMirror
            value={inline.code}
            height="200px"
            extensions={[javascript()]}
            aria-label="Hook code"
            onChange={(value) => set({ code: value })}
          />
        </div>
      </Field>
      {templates.length > 0 && (
        <div className="field">
          <span className="field-label">Start from a template</span>
          <div className="hook-templates">
            {templates.map((template) => (
              <button
                key={template.id}
                type="button"
                className="btn btn-sm btn-add-hook"
                title={`Use the ${template.name} hook (${template.when})`}
                onClick={() => applyTemplate(inline, set, template)}
              >
                {template.name}
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

/** The hook Inspector described above. */
export function HookFields({ node, graph, patch, replace }: KindFieldsProps<'hook'>): JSX.Element {
  const { item } = node.data;
  const source: HookSource = 'file' in item ? 'file' : 'inline';
  const onSource = (next: HookSource | undefined) => {
    if (next === undefined || next === source) return;
    if (next === 'file') {
      replace({ item: { id: item.id, file: '' } });
    } else {
      replace({ item: { id: item.id, inline: { name: 'hook', point: 'preToolCall', code: '' } } });
    }
  };
  return (
    <>
      <ChoiceField
        id="node-hook-source"
        label="Source"
        value={source}
        options={SOURCE_OPTIONS}
        onChange={onSource}
      />
      {'file' in item ? <FileForm item={item} patch={patch} /> : <InlineForm item={item} patch={patch} />}
      <Field id="node-hook-id" label="Id" required error={idError(node, graph)}>
        <Input
          value={item.id}
          onChange={(event: ChangeEvent<HTMLInputElement>) => patch({ id: event.target.value })}
        />
      </Field>
    </>
  );
}
