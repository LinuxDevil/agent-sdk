import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import './jsonView.css';

/**
 * Props for {@link JsonView}. `defaultExpandDepth` is how many levels open on
 * first render (default 4); deeper containers start collapsed and expand on click.
 */
export interface JsonViewProps {
  value: unknown;
  /** Key shown before the root value, if any. */
  name?: string;
  defaultExpandDepth?: number;
}

interface Container {
  /** Text shown when the container has no entries. */
  empty: string;
  /** Text shown after the key for a non-empty container, given its size. */
  summary: (size: number) => string;
  entries: [string, unknown][];
}

interface NodeProps {
  value: unknown;
  name?: string;
  depth: number;
  defaultExpandDepth: number;
}

/** Entries rendered per container before a "Show N more" row, so huge arrays stay cheap. */
const PAGE = 100;

const SCALAR_CLASS: Record<string, string | undefined> = {
  string: 'json-str',
  number: 'json-num',
  boolean: 'json-bool',
  undefined: 'json-null',
};

function Row({ name, children }: { name?: string; children: ReactNode }) {
  return (
    <div className="json-node">
      {name !== undefined && <span className="json-key">{name}: </span>}
      {children}
    </div>
  );
}

/** Rendering for non-container values: the class + text of the value's span. */
function scalarSpan(value: unknown): ReactNode {
  const className = value === null ? 'json-null' : SCALAR_CLASS[typeof value];
  const text = typeof value === 'string' ? `"${value}"` : String(value);
  return <span className={className}>{text}</span>;
}

/** Arrays and plain objects are expandable containers; everything else is a scalar. */
function describeContainer(value: unknown): Container | undefined {
  if (Array.isArray(value)) {
    return {
      empty: '[]',
      summary: (size) => `Array(${size})`,
      entries: value.map((item, i): [string, unknown] => [String(i), item]),
    };
  }
  if (typeof value === 'object' && value !== null) {
    return {
      empty: '{}',
      summary: (size) => `{${size}}`,
      entries: Object.entries(value as Record<string, unknown>),
    };
  }
  return undefined;
}

/** A collapsible container (array or object): toggle, key, summary, children. */
function Branch({ name, container, depth, defaultExpandDepth }: Omit<NodeProps, 'value'> & { container: Container }) {
  const [expanded, setExpanded] = useState(depth < defaultExpandDepth);
  const [shown, setShown] = useState(PAGE);
  const hidden = container.entries.length - shown;
  return (
    <div className="json-node">
      <button
        type="button"
        className="json-toggle"
        aria-expanded={expanded}
        aria-label={`Toggle ${name ?? 'root'}`}
        onClick={() => setExpanded((e) => !e)}
      >
        {expanded ? <ChevronDown size={12} strokeWidth={2} aria-hidden="true" /> : <ChevronRight size={12} strokeWidth={2} aria-hidden="true" />}
      </button>
      {name !== undefined && <span className="json-key">{name}: </span>}
      <span className="json-null">{container.summary(container.entries.length)}</span>
      {expanded && (
        <div className="json-children">
          {container.entries.slice(0, shown).map(([k, v]) => (
            <JsonNode key={k} value={v} name={k} depth={depth + 1} defaultExpandDepth={defaultExpandDepth} />
          ))}
          {hidden > 0 && (
            <button type="button" className="json-toggle json-more" onClick={() => setShown(container.entries.length)}>
              Show {hidden} more
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function JsonNode({ value, name, depth, defaultExpandDepth }: NodeProps) {
  const container = describeContainer(value);
  if (!container) return <Row name={name}>{scalarSpan(value)}</Row>;
  if (container.entries.length === 0) {
    return (
      <Row name={name}>
        <span className="json-null">{container.empty}</span>
      </Row>
    );
  }
  return <Branch name={name} container={container} depth={depth} defaultExpandDepth={defaultExpandDepth} />;
}

/**
 * Hand-rolled, collapsible JSON tree - no dependency needed for this. Drawn as a
 * mono 12px code block on `--surface-3`, with keys, strings, numbers, booleans and
 * nulls in theme token colours.
 * Containers deeper than `defaultExpandDepth` (default 4) start collapsed, so a
 * giant `ExecutionResult` or deeply nested payload is not dumped fully expanded.
 */
export function JsonView({ value, name, defaultExpandDepth = 4 }: JsonViewProps) {
  return (
    <div className="json-view">
      <JsonNode value={value} name={name} depth={0} defaultExpandDepth={defaultExpandDepth} />
    </div>
  );
}
