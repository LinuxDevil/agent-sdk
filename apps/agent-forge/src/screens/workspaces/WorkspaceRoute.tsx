import './workspaces.css';
import { useState } from 'react';
import { CircleAlert, SearchX } from 'lucide-react';
import type { ApiClient } from '@linuxdevil/lousho/workspaces/client';
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
import { useWorkspaceOps, type OpsSender } from './useWorkspaceOps';
import { workspacePath, type WorkspaceSection } from './workspacesUrl';
import { WorkspaceContext, type WorkspaceContextValue } from './WorkspaceContext';

type WorkspaceData = Pick<WorkspaceContextValue, 'workspace' | 'problems' | 'drafts'>;

const SECTION_PATTERNS: string[] = ['/workspaces/:id/:section', '/workspaces/:id'];

function loadWorkspace(client: ApiClient, id: string): Promise<WorkspaceData> {
  return Promise.all([
    client.call('getWorkspace', { params: { id } }),
    client.call('getProblems', { params: { id } }),
    client.call('listDrafts', { params: { id } }),
  ]).then(([workspace, problems, drafts]) => ({ workspace, problems, drafts }));
}

function workspaceSection(path: string): { id: string; section: WorkspaceSection } {
  const route = matchRoute(`#${path}`, SECTION_PATTERNS);
  const sectionParam = route?.params.section;
  const section =
    sectionParam !== undefined && isWorkspaceSection(sectionParam) ? sectionParam : 'overview';
  return { id: route?.params.id ?? '', section };
}

function WorkspaceLoading() {
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

function WorkspaceError({ error, onRetry }: { error: string; onRetry(): void }) {
  return (
    <div className="app app-screen">
      <PageHeader title="Workspaces" />
      <main className="screen-main">
        <EmptyState
          icon={CircleAlert}
          title="Could not load this workspace"
          hint={error}
          action={
            <button type="button" className="btn" onClick={onRetry}>
              Retry
            </button>
          }
        />
      </main>
    </div>
  );
}

function WorkspaceNotFound({ id }: { id: string }) {
  return (
    <div className="app app-screen">
      <PageHeader title="Workspaces" />
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

function WorkspaceHeader({
  workspace,
  problems,
  drafts,
  onChat,
  onOpenDraft,
}: Pick<WorkspaceContextValue, 'workspace' | 'problems' | 'drafts'> & {
  onChat(): void;
  onOpenDraft(): void;
}) {
  const errorCount = problems.filter((problem) => problem.severity === 'error').length;
  return (
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
              onClick={onOpenDraft}
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
          <button type="button" className="btn" onClick={onChat}>
            Chat
          </button>
        </>
      }
    />
  );
}

function SectionNav({ workspaceId, section }: { workspaceId: string; section: WorkspaceSection }) {
  return (
    <nav className="ws-sidenav" aria-label="Workspace sections">
      <ul onKeyDown={onRovingKeyDown}>
        {WORKSPACE_SECTIONS.map((item) => (
          <li key={item.id}>
            <a
              data-roving
              href={`#${workspacePath(workspaceId, item.id)}`}
              aria-current={item.id === section ? 'page' : undefined}
            >
              {item.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function SectionBody({ workspaceId, section }: { workspaceId: string; section: WorkspaceSection }) {
  const entry = WORKSPACE_SECTIONS.find((item) => item.id === section);
  const SectionScreen = SECTION_SCREENS[section];
  return (
    <main className="screen-main" id="workspace-section-panel">
      {SectionScreen ? (
        <SectionScreen key={workspaceId} />
      ) : (
        <EmptyState
          title={`${entry?.label ?? section} is not built yet`}
          hint={`This section lands with ${entry?.ticket ?? 'a later ticket'}.`}
        />
      )}
    </main>
  );
}

function LoadedWorkspace({
  id,
  section,
  data,
  ops,
  refresh,
}: {
  id: string;
  section: WorkspaceSection;
  data: WorkspaceData;
  ops: OpsSender;
  refresh(): void;
}) {
  const [chat, setChat] = useState<{ pageId?: string } | undefined>(undefined);
  const [draftOpen, setDraftOpen] = useState(false);
  const { workspace, problems, drafts } = data;
  const context: WorkspaceContextValue = {
    workspace,
    problems,
    drafts,
    ops,
    refresh,
    openChat: (focus) => setChat(focus ?? {}),
    openDraft: () => setDraftOpen(true),
  };
  return (
    <WorkspaceContext.Provider value={context}>
      <div className="app app-screen">
        <WorkspaceHeader
          workspace={workspace}
          problems={problems}
          drafts={drafts}
          onChat={() => setChat({})}
          onOpenDraft={() => setDraftOpen(true)}
        />
        <div className="ws-layout">
          <SectionNav workspaceId={id} section={section} />
          <SectionBody workspaceId={id} section={section} />
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

export function WorkspaceRoute() {
  const { path } = useRoute();
  const { id, section } = workspaceSection(path);
  const state = useClientQuery((client) => loadWorkspace(client, id), `workspace:${id}`);
  const ops = useWorkspaceOps(id, state.data?.workspace.revision, state.refresh);

  if (state.loading && state.data === undefined) return <WorkspaceLoading />;
  if (state.error !== undefined) return <WorkspaceError error={state.error} onRetry={state.refresh} />;
  if (state.notFound || state.data === undefined) return <WorkspaceNotFound id={id} />;
  return <LoadedWorkspace id={id} section={section} data={state.data} ops={ops} refresh={state.refresh} />;
}
