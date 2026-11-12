import type { ReactElement, ReactNode } from 'react';
import type { UiArtifactView, UiOutputField, UiRunWidget, UiText } from 'lousho/workspaces/client';
import type { RenderContext } from '../context';
import { getAt } from '../paths';
import { isRecord } from '../schema';

export function outputValue(ctx: RenderContext, source: string): unknown {
  return getAt({ outputs: ctx.run.view?.result?.output }, source);
}

export function toText(value: unknown): string {
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value : typeof value === 'object' ? JSON.stringify(value) : String(value);
}

export function OutputBlock({ label, children }: { label?: string; children: ReactNode }): ReactElement {
  return (
    <div className="lwr-output">
      {label !== undefined && <p className="lwr-label">{label}</p>}
      {children}
    </div>
  );
}

export function TextOutput({ node, ctx }: { node: UiText; ctx: RenderContext }): ReactElement {
  return (
    <OutputBlock label={node.label}>
      <p className="lwr-text">{toText(outputValue(ctx, node.source ?? 'outputs'))}</p>
    </OutputBlock>
  );
}

export function Markdown({ node, ctx }: { node: UiOutputField; ctx: RenderContext }): ReactElement {
  return (
    <OutputBlock label={node.label}>
      <div className="lwr-markdown lwr-pre">{toText(outputValue(ctx, node.source))}</div>
    </OutputBlock>
  );
}

export function JsonOutput({ node, ctx }: { node: UiOutputField; ctx: RenderContext }): ReactElement {
  const value = outputValue(ctx, node.source);
  return (
    <OutputBlock label={node.label}>
      <pre className="lwr-json">{value === undefined ? '' : JSON.stringify(value, null, 2)}</pre>
    </OutputBlock>
  );
}

function columnsOf(rows: readonly unknown[]): string[] {
  const keys = new Set<string>();
  for (const row of rows) if (isRecord(row)) for (const key of Object.keys(row)) keys.add(key);
  return keys.size === 0 ? ['Value'] : [...keys];
}

const cellOf = (row: unknown, column: string): string => toText(isRecord(row) ? row[column] : row);

export function TableOutput({ node, ctx }: { node: UiOutputField; ctx: RenderContext }): ReactElement {
  const value = outputValue(ctx, node.source);
  const rows = Array.isArray(value) ? value : [];
  const columns = columnsOf(rows);
  return (
    <table className="lwr-table">
      {node.label !== undefined && <caption>{node.label}</caption>}
      <thead>
        <tr>{columns.map((column) => <th key={column} scope="col">{column}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((row, index) => (
          <tr key={index}>{columns.map((column) => <td key={column}>{cellOf(row, column)}</td>)}</tr>
        ))}
      </tbody>
    </table>
  );
}

export function ArtifactOutput({ node, ctx }: { node: UiArtifactView; ctx: RenderContext }): ReactElement {
  const ref = ctx.run.artifacts.find((artifact) => artifact.name === node.artifact);
  return (
    <OutputBlock label={node.label ?? node.artifact}>
      <p className="lwr-note">{ref === undefined ? 'No file yet' : ref.name}</p>
    </OutputBlock>
  );
}

export function ArtifactGallery({ node, ctx }: { node: UiRunWidget; ctx: RenderContext }): ReactElement {
  return (
    <OutputBlock label={node.label}>
      <ul className="lwr-gallery">{ctx.run.artifacts.map((artifact) => <li key={artifact.uri}>{artifact.name}</li>)}</ul>
    </OutputBlock>
  );
}
