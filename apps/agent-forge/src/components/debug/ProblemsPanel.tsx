/**
 * The drawer's Problems tab (C19): every `validateGraph` problem — core,
 * per-kind and AgentSpec v2 schema — as a `DataTable` sorted errors first
 * then node walk order. Opening a row selects the node on the canvas
 * (`setSelectedNodeId`; `useKeepSelectionInView` pans it into view) and
 * its Inspector shows the node's problems.
 */
import { useMemo } from 'react';
import { CircleAlert, CircleCheck, TriangleAlert } from 'lucide-react';
import { useAppState } from '../../state/AppState';
import { orderedNodes } from '../../graph/v2/order';
import type { Graph, GraphNode, Problem } from '../../graph/v2/types';
import { viewFor } from '../../canvas/kinds';
import { DataTable, type Column } from '../../ui/DataTable';
import { EmptyState } from '../../ui/EmptyState';

const SEVERITY_RANK: Record<Problem['severity'], number> = { error: 0, warning: 1 };

/** A problem plus its node's walk position, for the errors-first-then-walk-order sort. */
interface ProblemRow {
  problem: Problem;
  node: GraphNode | undefined;
  order: number;
}

/** Rows of `problems` sorted errors first, then node walk order (`orderedNodes`). */
function problemRows(graph: Graph, problems: Problem[]): ProblemRow[] {
  const rank = new Map(orderedNodes(graph).map((n, i) => [n.id, i]));
  return problems
    .map((problem) => ({
      problem,
      node: graph.nodes.find((n) => n.id === problem.nodeId),
      order: rank.get(problem.nodeId) ?? Number.MAX_SAFE_INTEGER,
    }))
    .sort(
      (a, b) =>
        SEVERITY_RANK[a.problem.severity] - SEVERITY_RANK[b.problem.severity] || a.order - b.order
    );
}

/** The Severity cell: the severity icon plus its word. */
function SeverityCell({ problem }: { problem: Problem }) {
  const Icon = problem.severity === 'error' ? CircleAlert : TriangleAlert;
  return (
    <span className={`problem-severity problem-severity-${problem.severity}`}>
      <Icon size={14} strokeWidth={1.75} aria-hidden="true" />
      {problem.severity === 'error' ? 'Error' : 'Warning'}
    </span>
  );
}

/** The Node cell: the kind's icon tile plus the node's title (the id when the node is gone). */
function NodeCell({ row }: { row: ProblemRow }) {
  const { node, problem } = row;
  if (node === undefined) return <span className="problem-node-gone">{problem.nodeId}</span>;
  const view = viewFor(node.kind);
  const { Icon } = view;
  const title = view.title(node as never);
  return (
    <span className="problem-node" title={title}>
      <span className={`node-kind kind-${view.tone}`} aria-hidden="true">
        <Icon size={12} strokeWidth={1.75} />
      </span>
      <span className="problem-node-title">{title}</span>
    </span>
  );
}

function FieldCell({ problem }: { problem: Problem }) {
  return problem.fieldPath ? <code className="problem-field">{problem.fieldPath}</code> : null;
}

function problemColumns(): Column<ProblemRow>[] {
  return [
    {
      key: 'severity',
      header: 'Severity',
      label: 'Severity',
      width: 110,
      render: (row) => <SeverityCell problem={row.problem} />,
    },
    {
      key: 'node',
      header: 'Node',
      label: 'Node',
      width: 200,
      render: (row) => <NodeCell row={row} />,
    },
    {
      key: 'message',
      header: 'Message',
      label: 'Message',
      render: (row) => row.problem.message,
    },
    {
      key: 'field',
      header: 'Field',
      label: 'Field',
      width: 180,
      render: (row) => <FieldCell problem={row.problem} />,
    },
  ];
}

/** The Problems tab's body: the sorted problem table, or the all-clear empty state. */
export function ProblemsPanel() {
  const { graph, problems, setSelectedNodeId } = useAppState();
  // `?? []`: AppState always provides `problems`; lightweight test doubles may not.
  const rows = useMemo(() => problemRows(graph, problems ?? []), [graph, problems]);
  const columns = useMemo(problemColumns, []);

  return (
    <DataTable
      id="drawer-problems"
      columns={columns}
      rows={rows}
      rowKey={(row) => `${row.problem.nodeId}${row.problem.fieldPath ?? ''}:${row.problem.message}`}
      density="compact"
      onRowOpen={(row) => setSelectedNodeId(row.problem.nodeId)}
      empty={
        <EmptyState icon={CircleCheck} title="No problems" hint="Everything on the canvas is valid." />
      }
    />
  );
}
