export type WorkspaceSection = 'overview' | 'main-agent' | 'pages' | 'agents' | 'runs' | 'improve' | 'revisions';

export interface WorkspacesUrlState {
  q?: string;
}

export function parseWorkspacesQuery(query: URLSearchParams): WorkspacesUrlState {
  const q = query.get('q')?.trim();
  return q ? { q } : {};
}

export function workspacesHref(state: WorkspacesUrlState): string {
  return state.q ? `/workspaces?${new URLSearchParams({ q: state.q })}` : '/workspaces';
}

export function workspacePath(id: string, section?: WorkspaceSection): string {
  const base = `/workspaces/${encodeURIComponent(id)}`;
  return section === undefined ? base : `${base}/${section}`;
}
