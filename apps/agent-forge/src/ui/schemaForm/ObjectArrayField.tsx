import { useState } from 'react';
import { ArrowDown, ArrowUp, ChevronRight, Plus, Trash2 } from 'lucide-react';

// fallow-ignore-next-line circular-dependency -- container fields recurse into SchemaNode, which dispatches back through FIELD_RENDERERS; the recursion is inherent to schema dispatch and safe at render time.
import { fieldId, fieldLabel, SchemaNode, type FieldRendererProps } from './fields';
import { pathKey, resolveRef } from './schemaPath';
import type { SchemaPath } from './types';
import { usePendingFocus } from './usePendingFocus';
import { defaultForSchema, itemSummary } from './variants';

/**
 * The array-of-objects renderer: collapsible, reorderable, removable items
 * with `itemSummary` titles. New items are appended expanded with
 * `defaultForSchema(items)`. Reorder/remove keep keyboard focus on the moved
 * item's button, the next item's toggle or the Add button.
 */
export function ObjectArrayField({ root, schema, path, value, required, ctx }: FieldRendererProps): JSX.Element {
  const label = fieldLabel(schema, path, ctx);
  const singular = label.replace(/s$/, '');
  const list = Array.isArray(value) ? value : [];
  const itemsSchema = schema.items == null ? {} : resolveRef(root, schema.items);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(
    () => new Set(list.map((_, i) => i)),
  );
  const { ref: containerRef, focus } = usePendingFocus<HTMLDivElement>();

  const setList = (next: unknown[]) =>
    ctx.onChange(path, next.length === 0 && !required ? undefined : next);

  const add = () => {
    setExpanded((prev) => new Set(prev).add(list.length));
    ctx.onChange(path, [...list, defaultForSchema(root, itemsSchema)]);
  };

  const toggle = (index: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });

  const move = (from: number, to: number) => {
    const next = [...list];
    [next[from], next[to]] = [next[to], next[from]];
    setExpanded(swapIndex(expanded, from, to));
    // Keep focus on the moved item's same-direction button; at the edge that button
    // is disabled, so land on the other direction instead.
    const dir = to === 0 ? 'down' : to === next.length - 1 ? 'up' : to < from ? 'up' : 'down';
    const summary = itemSummary(next[to], to);
    focus(`li.schema-item[data-index="${to}"] button[aria-label="Move ${escapeAttr(summary)} ${dir}"]`);
    setList(next);
  };

  const remove = (index: number) => {
    const next = list.filter((_, i) => i !== index);
    setExpanded(shiftIndex(expanded, index));
    focus(
      next.length > index || index > 0
        ? `li.schema-item[data-index="${next.length > index ? index : index - 1}"] .schema-item-toggle`
        : '.schema-list-add',
    );
    setList(next);
  };

  return (
    <div className="field" data-path={pathKey(path)} ref={containerRef}>
      <div className="field-label">
        {label}
        <span className="schema-count tabular-nums">{list.length}</span>
      </div>
      <ol className="schema-items">
        {list.map((item, i) => (
          <ArrayItem
            key={i}
            root={root}
            schema={itemsSchema}
            path={[...path, i]}
            value={item}
            index={i}
            last={list.length - 1}
            expanded={expanded.has(i)}
            readOnly={ctx.readOnly}
            ctx={ctx}
            onToggle={() => toggle(i)}
            onMove={(to) => move(i, to)}
            onRemove={() => remove(i)}
          />
        ))}
      </ol>
      {ctx.readOnly ? null : (
        <button type="button" className="btn btn-sm schema-list-add" onClick={add}>
          <Plus size={16} strokeWidth={1.75} aria-hidden="true" /> Add {singular}
        </button>
      )}
    </div>
  );
}

interface ArrayItemProps {
  root: FieldRendererProps['root'];
  schema: FieldRendererProps['schema'];
  path: SchemaPath;
  value: unknown;
  index: number;
  last: number;
  expanded: boolean;
  readOnly: boolean;
  ctx: FieldRendererProps['ctx'];
  onToggle(): void;
  onMove(to: number): void;
  onRemove(): void;
}

/** One collapsible row: toggle + move/remove buttons over a nested form body. */
function ArrayItem(props: ArrayItemProps): JSX.Element {
  const { root, schema, path, value, index, last, expanded, readOnly, ctx, onToggle, onMove, onRemove } =
    props;
  const summary = itemSummary(value, index);
  const bodyId = `${fieldId(ctx.idPrefix, path)}-body`;
  return (
    <li className="schema-item" data-index={index}>
      <div className="schema-item-head">
        <button
          type="button"
          className="schema-item-toggle"
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={onToggle}
        >
          <ChevronRight size={14} strokeWidth={1.75} aria-hidden="true" />
          <span className="schema-item-summary">{summary}</span>
        </button>
        {readOnly ? null : (
          <>
            <button
              type="button"
              className="btn btn-ghost btn-icon btn-sm"
              aria-label={`Move ${summary} up`}
              disabled={index === 0}
              onClick={() => onMove(index - 1)}
            >
              <ArrowUp size={16} strokeWidth={1.75} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-icon btn-sm"
              aria-label={`Move ${summary} down`}
              disabled={index === last}
              onClick={() => onMove(index + 1)}
            >
              <ArrowDown size={16} strokeWidth={1.75} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-icon btn-sm btn-danger-text"
              aria-label={`Remove ${summary}`}
              onClick={onRemove}
            >
              <Trash2 size={16} strokeWidth={1.75} aria-hidden="true" />
            </button>
          </>
        )}
      </div>
      {expanded ? (
        <div className="schema-item-body" id={bodyId}>
          <SchemaNode root={root} schema={schema} path={path} value={value} required={false} ctx={ctx} />
        </div>
      ) : null}
    </li>
  );
}

/** Keeps per-index expansion attached to items after an adjacent swap. */
function swapIndex(set: ReadonlySet<number>, a: number, b: number): Set<number> {
  const next = new Set(set);
  const hadA = next.has(a);
  const hadB = next.has(b);
  if (hadA) next.add(b);
  else next.delete(b);
  if (hadB) next.add(a);
  else next.delete(a);
  return next;
}

/** Keeps per-index expansion attached to items after index `removed` is deleted. */
function shiftIndex(set: ReadonlySet<number>, removed: number): Set<number> {
  const next = new Set<number>();
  for (const i of set) {
    if (i < removed) next.add(i);
    else if (i > removed) next.add(i - 1);
  }
  return next;
}

/** Double-quotes inside an aria-label would break the focus selector; escape them. */
function escapeAttr(text: string): string {
  return text.replace(/["\\]/g, '\\$&');
}
