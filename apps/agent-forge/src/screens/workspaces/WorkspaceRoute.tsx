import './workspaces.css';
import { useState } from 'react';
import { CircleAlert, SearchX } from 'lucide-react';
import { matchRoute } from '../../router/router';
import { useRoute } from '../../router/useRoute';
import { EmptyState } from '../../ui/EmptyState';
import { PageHeader } from '../../ui/PageHeader';
import { Sheet } from '../../ui/Sheet';
import { Skeleton } from '../../ui/Skeleton';
import { StatusBadge } from '../../ui/StatusBadge';
import { onRovingKeyDown } from '../rovingKeys';
import { ChatSheet } from './ChatSheet';
import { SECTION_SCREENS, WORKSPACE_SECTIONS, isWorkspaceSection } from './sections';
import { useClientQuery } from './useClientQuery';
import { useWorkspaceOps } from './useWorkspaceOps';
import { workspacePath, type WorkspaceSection } from './workspacesUrl';
import { WorkspaceContext, type WorkspaceContextValue } from './WorkspaceContext';

export function WorkspaceRoute() {
  const { path } = useRoute();
  const route = matchRoute(`#${path}`, ['/workspaces/:id/:section', '/workspaces/:id']);
  const id = route?.params.id ?? '';
  const sectionParam = route?.params.section;
  const section: WorkspaceSection = sectionParam !== undefined && isWorkspaceSection(sectionParam) ? sectionParam : 'overview';
  const [chat, setChat] = useState<{ pageId?: string } | undefined>(undefined);
  const [draftOpen, setDraftOpen] = useState(false);
  const state = useClientQuery(async (client) => {
    const [workspace, problems, drafts] = await Promise.all([
      client.call('getWorkspace', { params: { id } }),
      client.call('getProblems', { params: { id } }),
      client.call('listDrafts', { params: { id } }),
    ]);
    return { workspace, problems, drafts };
  }, `workspace:${id}`);
  const ops = useWorkspaceOps(id, state.data?.workspace.revision, state.refresh);

  if (state.loading && state.data === undefined) {
    return (
      <div className="app app-screen">
        <header className="page-header">
          <div className="page-header-main">
            <Skeleton width={220} height={24} />
            <Skeleton width={320} height={14} />
          </div>
          <span role="status" className="visually-hidden">
            Loading workspace
          </span>
        </header>
        <main className="screen-main" />
      </div>
    );
  }

  if (state.error !== undefined) {
    return (
      <div className="app app-screen">
        <main className="screen-main">
          <EmptyState
            icon={CircleAlert}
            title="Could not load this workspace"
            hint={state.error}
            action={
              <button type="button" className="btn" onClick={state.refresh}>
                Retry
              </button>
            }
          />
        </main>
      </div>
    );
  }

  if (state.notFound || state.data === undefined) {
    return (
      <div className="app app-screen">
        <main className="screen-main">
          <EmptyState
            icon={SearchX}
            title="Workspace not found"
            hint={`No workspace called “${id}”.`}
            action={
              <a className="btn" href="#/workspaces">
                Back to workspaces
              </a>
            }
          />
        </main>
      </div>
    );
  }

  const { workspace, problems, drafts } = state.data;
  const errorCount = problems.filter((problem) => problem.severity === 'error').length;
  const entry = WORKSPACE_SECTIONS.find((item) => item.id === section);
  const SectionScreen = SECTION_SCREENS[section];
  const context: WorkspaceContextValue = {
    workspace,
    problems,
    drafts,
    ops,
    refresh: state.refresh,
    openChat: (focus) => setChat(focus ?? {}),
    openDraft: () => setDraftOpen(true),
  };

  return (
    <WorkspaceContext.Provider value={context}>
      <div className="app app-screen">
        <PageHeader
          title={workspace.name}
          breadcrumbs={[{ label: 'Workspaces', href: '#/workspaces' }, { label: workspace.name }]}
          status={
            <>
              <code className="ws-revision" title="Live revision">
                {workspace.revision}
              </code>
              <StatusBadge
                status={errorCount === 0 ? 'done' : 'error'}
                label={errorCount === 0 ? 'Valid' : `Invalid (${errorCount})`}
                size="sm"
              />
              {drafts.length > 0 ? (
                <button
                  type="button"
                  className="btn btn-sm"
                  title={drafts.map((draft) => `${draft.createdBy} is editing`).join(', ')}
                  onClick={() => setDraftOpen(true)}
                >
                  Draft open
                </button>
              ) : null}
            </>
          }
          actions={
            <>
              <button type="button" className="btn" title="Runs land with P3.13" disabled>
                Run
              </button>
              <button type="button" className="btn" onClick={() => setChat({})}>
                Chat
              </button>
            </>
          }
        />
        <div className="ws-layout">
          <nav className="ws-sidenav" aria-label="Workspace sections">
            <ul onKeyDown={onRovingKeyDown}>
              {WORKSPACE_SECTIONS.map((item) => (
                <li key={item.id}>
                  <a
                    data-roving
                    href={`#${workspacePath(id, item.id)}`}
                    aria-current={item.id === section ? 'page' : undefined}
                  >
                    {item.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
          <main className="screen-main" id="workspace-section-panel">
            {SectionScreen ? (
              <SectionScreen key={workspace.id} />
            ) : (
              <EmptyState
                title={`${entry?.label ?? section} is not built yet`}
                hint={`This section lands with ${entry?.ticket ?? 'a later ticket'}.`}
              />
            )}
          </main>
        </div>
        <ChatSheet open={chat !== undefined} focus={chat} onClose={() => setChat(undefined)} />
        <Sheet open={draftOpen} onClose={() => setDraftOpen(false)} title="Draft">
          <EmptyState
            title="Draft review lands with P2.22"
            hint="Apply or discard it with the authoring chat until then."
          />
        </Sheet>
      </div>
    </WorkspaceContext.Provider>
  );
}
