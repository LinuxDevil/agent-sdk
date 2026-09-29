import { useState, type ReactNode } from 'react';

/**
 * O4: hand-rolled, collapsible JSON tree - no dependency needed for this.
 * `defaultExpandDepth` keeps the tree from dumping a giant `ExecutionResult`
 * fully expanded on first render.
 */
export function JsonTree({ value, name, depth = 0, defaultExpandDepth = 2 }: { value: unknown; name?: string; depth?: number; defaultExpandDepth?: number }) {
  const [expanded, setExpanded] = useState(depth < defaultExpandDepth);

  if (value === null) return <Row name={name}><span className="json-null">null</span></Row>;
  if (value === undefined) return <Row name={name}><span className="json-null">undefined</span></Row>;

  if (Array.isArray(value)) {
    if (value.length === 0) return <Row name={name}><span className="json-null">[]</span></Row>;
    return (
      <div className="json-node">
        <button type="button" className="json-toggle" onClick={() => setExpanded((e) => !e)}>
          {expanded ? '▾' : '▸'}
        </button>
        {name !== undefined && <span className="json-key">{name}: </span>}
        <span className="json-null">Array({value.length})</span>
        {expanded && (
          <div className="json-children">
            {value.map((item, i) => (
              <JsonTree key={i} value={item} name={String(i)} depth={depth + 1} defaultExpandDepth={defaultExpandDepth} />
            ))}
          </div>
        )}
      </div>
    );
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return <Row name={name}><span className="json-null">{'{}'}</span></Row>;
    return (
      <div className="json-node">
        <button type="button" className="json-toggle" onClick={() => setExpanded((e) => !e)}>
          {expanded ? '▾' : '▸'}
        </button>
        {name !== undefined && <span className="json-key">{name}: </span>}
        <span className="json-null">{'{' + entries.length + '}'}</span>
        {expanded && (
          <div className="json-children">
            {entries.map(([k, v]) => (
              <JsonTree key={k} value={v} name={k} depth={depth + 1} defaultExpandDepth={defaultExpandDepth} />
            ))}
          </div>
        )}
      </div>
    );
  }

  if (typeof value === 'string') {
    return (
      <Row name={name}>
        <span className="json-str">&quot;{value}&quot;</span>
      </Row>
    );
  }
  if (typeof value === 'number') {
    return (
      <Row name={name}>
        <span className="json-num">{value}</span>
      </Row>
    );
  }
  if (typeof value === 'boolean') {
    return (
      <Row name={name}>
        <span className="json-bool">{String(value)}</span>
      </Row>
    );
  }
  return (
    <Row name={name}>
      <span>{String(value)}</span>
    </Row>
  );
}

function Row({ name, children }: { name?: string; children: ReactNode }) {
  return (
    <div className="json-node">
      {name !== undefined && <span className="json-key">{name}: </span>}
      {children}
    </div>
  );
}
