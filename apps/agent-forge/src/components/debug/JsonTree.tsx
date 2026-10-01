import { useState, type ReactNode } from 'react';

interface JsonTreeProps {
  value: unknown;
  name?: string;
  depth?: number;
  defaultExpandDepth?: number;
}

interface Container {
  /** Text shown when the container has no entries. */
  empty: string;
  /** Text shown after the key for a non-empty container, given its size. */
  summary: (size: number) => string;
  entries: [string, unknown][];
}

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
function Branch({
  name,
  container,
  depth,
  defaultExpandDepth,
}: {
  name?: string;
  container: Container;
  depth: number;
  defaultExpandDepth: number;
}) {
  const [expanded, setExpanded] = useState(depth < defaultExpandDepth);
  return (
    <div className="json-node">
      <button type="button" className="json-toggle" onClick={() => setExpanded((e) => !e)}>
        {expanded ? '▾' : '▸'}
      </button>
      {name !== undefined && <span className="json-key">{name}: </span>}
      <span className="json-null">{container.summary(container.entries.length)}</span>
      {expanded && (
        <div className="json-children">
          {container.entries.map(([k, v]) => (
            <JsonTree key={k} value={v} name={k} depth={depth + 1} defaultExpandDepth={defaultExpandDepth} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * O4: hand-rolled, collapsible JSON tree - no dependency needed for this.
 * `defaultExpandDepth` keeps the tree from dumping a giant `ExecutionResult`
 * fully expanded on first render.
 */
export function JsonTree({ value, name, depth = 0, defaultExpandDepth = 2 }: JsonTreeProps) {
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
