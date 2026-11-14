/**
 * `ToolCatalogPicker` — the `{ builtin }` name control. A search input
 * filters the `useCatalog('tools')` rows; the listbox below shows each
 * tool's name and description plus `edits data` / `needs <key>` chips.
 * Up/Down moves the active row, Enter picks it, a click picks too.
 * Loading shows skeleton rows; a failed fetch shows the message and a
 * Retry that re-arms the catalog request.
 */
import { useState, type ChangeEvent, type KeyboardEvent } from 'react';
import { Field } from '../../../ui/Field';
import { Input } from '../../../ui/controls';
import { SkeletonRows } from '../../../ui/Skeleton';
import { refreshCatalog, useCatalog } from '../../useCatalog';
import type { CatalogTool } from '../../../../shared/wireTypes';
import './tool.css';

/** Props for {@link ToolCatalogPicker}. */
export interface ToolCatalogPickerProps {
  /** Control id (`node-tool-builtin`). */
  id: string;
  /** `item.builtin`: a catalog `name`, or '' / an off-catalog name. */
  value: string;
  /** Emits the picked tool's catalog `name`. */
  onChange(name: string): void;
  /** Spec-path suffix for `data-field-path` (Inspector Problems focus, C19). */
  fieldPath?: string;
}

/** The tools whose name or description contains `query` (case-insensitive). */
function filterTools(tools: CatalogTool[], query: string): CatalogTool[] {
  const q = query.trim().toLowerCase();
  if (q === '') return tools;
  return tools.filter(
    (tool) => tool.name.toLowerCase().includes(q) || tool.description.toLowerCase().includes(q)
  );
}

/** The hint under the field: the picked tool's description, or the off-catalog warning. */
function hintOf(value: string, picked: CatalogTool | undefined): string | undefined {
  if (value === '') return undefined;
  if (picked !== undefined) return picked.description;
  return 'Not in the catalog. The run will fail unless a local tool has this name.';
}

/** One listbox row: name, description and the mutating/credential chips. */
function ToolOption({
  tool,
  active,
  selected,
  onPick,
}: {
  tool: CatalogTool;
  active: boolean;
  selected: boolean;
  onPick(name: string): void;
}): JSX.Element {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      className={`tool-option${active ? ' tool-option-active' : ''}`}
      onClick={() => onPick(tool.name)}
    >
      <span className="tool-option-name mono">{tool.name}</span>
      <span className="tool-option-desc">{tool.description}</span>
      {(tool.mutating || tool.needsCredentials.length > 0) && (
        <span className="tool-option-chips">
          {tool.mutating && <code className="node-chip">edits data</code>}
          {tool.needsCredentials.map((key) => (
            <code className="node-chip" key={key}>
              needs {key}
            </code>
          ))}
        </span>
      )}
    </button>
  );
}

/**
 * The built-in tool picker described above; renders inside a `Field` so
 * the required 'Pick a tool' error and the description/warning hint use
 * the standard field chrome.
 */
export function ToolCatalogPicker({ id, value, onChange, fieldPath }: ToolCatalogPickerProps): JSX.Element {
  const catalog = useCatalog('tools');
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const tools = catalog.data;
  const filtered = filterTools(tools ?? [], query);
  const activeIndex = Math.min(active, Math.max(filtered.length - 1, 0));
  const picked = tools?.find((tool) => tool.name === value);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive(Math.min(activeIndex + 1, filtered.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive(Math.max(activeIndex - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const tool = filtered[activeIndex];
      if (tool !== undefined) onChange(tool.name);
    }
  };

  return (
    <Field id={id} label="Tool" required error={value === '' ? 'Pick a tool' : undefined} hint={hintOf(value, picked)} fieldPath={fieldPath}>
      {catalog.loading ? (
        <SkeletonRows rows={4} />
      ) : catalog.error !== undefined ? (
        <div className="tool-picker-error">
          <span className="hint">{catalog.error}</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => refreshCatalog('tools')}>
            Retry
          </button>
        </div>
      ) : (
        <>
          <Input
            aria-label="Search tools"
            placeholder="Search tools"
            value={query}
            onChange={(event: ChangeEvent<HTMLInputElement>) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
          />
          <div role="listbox" aria-label="Built-in tools" className="tool-picker-list">
            {filtered.map((tool, index) => (
              <ToolOption
                key={tool.name}
                tool={tool}
                active={index === activeIndex}
                selected={tool.name === value}
                onPick={onChange}
              />
            ))}
          </div>
        </>
      )}
    </Field>
  );
}
