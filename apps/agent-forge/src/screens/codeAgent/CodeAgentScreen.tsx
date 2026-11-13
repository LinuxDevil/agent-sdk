/**
 * `#/w/:ws/code-agents/:path` - one code-defined agent directory in one
 * workspace (W08b; X06b built the launch-folder-only version) shown on the
 * canvas read-only, with a banner naming the directory and a "Copy into
 * Studio" action that imports the spec as a new Studio agent IN THAT
 * WORKSPACE (L08a's `POST /agents/import` through `forWorkspace(ws)`).
 * The files are never touched: edits happen in the files or in the
 * Studio copy.
 */
import { useEffect, useMemo, useState } from 'react';
import { Folder, Info } from 'lucide-react';
import type { AgentSpecV2 } from '@linuxdevil/lousho';
import { stringify } from 'yaml';
import type { Graph } from '../../graph/v2/types';
import { specToGraph } from '../../graph/v2/specToGraph';
import { autoLayout } from '../../canvas/layout';
import { runtimeClient, RuntimeApiError } from '../../runtime/runtimeClient';
import { agentListPath, agentTabPath } from '../agents/agentTabs';
import { navigate, matchRoute } from '../../router/router';
import { useRoute } from '../../router/useRoute';
import { useWorkspacesMaybe } from '../../workspace/WorkspacesProvider';
import { workspaceLabel } from '../../workspace/workspaceLabels';
import { ScreenHeader } from '../../shell/ScreenHeader';
import { EmptyState } from '../../ui/EmptyState';
import { Skeleton } from '../../ui/Skeleton';
import { useToast } from '../../ui/Toast';
import { CodeAgentCanvas } from './CodeAgentCanvas';
import './codeAgent.css';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'not-found' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; spec: AgentSpecV2; warnings: string[]; graph: Graph };

/** The spec's graph with every node elkjs-positioned (empty layout: all `unplaced`). */
async function graphFor(spec: AgentSpecV2): Promise<Graph> {
  const base = specToGraph(spec);
  try {
    return await autoLayout(base, 'unplaced');
  } catch {
    // A layout failure must not hide the agent: the fallback positions still draw it.
    return base;
  }
}

function errorState(error: unknown): LoadState {
  if (error instanceof RuntimeApiError && error.status === 404) return { kind: 'not-found' };
  const message = error instanceof Error ? error.message : 'The agent could not be read.';
  return { kind: 'error', message };
}

/** Loads the directory's spec and lays its graph out; a new `path`/`workspaceId` restarts the load. */
function useCodeAgentSpec(workspaceId: string, path: string): LoadState {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    void (async () => {
      try {
        const { spec, warnings } = await runtimeClient.forWorkspace(workspaceId).loadCodeAgentSpec(path);
        const graph = await graphFor(spec);
        if (!cancelled) setState({ kind: 'ready', spec, warnings, graph });
      } catch (error) {
        if (!cancelled) setState(errorState(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId, path]);
  return state;
}

/** "Copy into Studio": the spec as YAML through `POST /agents/import` (mode `new`) in `workspaceId`, then open its canvas there. */
function useCopyIntoStudio(spec: AgentSpecV2 | undefined, workspaceId: string) {
  const toast = useToast();
  const [copying, setCopying] = useState(false);
  const copy = async () => {
    if (spec === undefined || copying) return;
    setCopying(true);
    try {
      const record = await runtimeClient.forWorkspace(workspaceId).importAgent({ text: stringify(spec), mode: 'new' });
      toast.show({
        message: `Copied as ${record.id}. Changes in Studio do not touch the files.`,
        tone: 'success',
      });
      navigate(agentTabPath(record.id, 'canvas', workspaceId));
    } catch (error) {
      toast.show({
        message: error instanceof Error ? error.message : 'The agent could not be copied.',
        tone: 'error',
      });
    } finally {
      setCopying(false);
    }
  };
  return { copying, copy };
}

function LoadingBody() {
  return (
    <div className="code-agent-body" aria-busy="true">
      <span className="visually-hidden" role="status">
        Loading agent
      </span>
      <Skeleton className="code-agent-skeleton" width="100%" height="60vh" />
    </div>
  );
}

function NotFoundBody({ workspaceId }: { workspaceId: string }) {
  return (
    <EmptyState
      title="Agent directory not found"
      hint="It may have been moved or deleted."
      action={
        <a className="btn btn-secondary btn-sm" href={`#${agentListPath(workspaceId)}`}>
          Back to agents
        </a>
      }
    />
  );
}

function ErrorBody({ message }: { message: string }) {
  return <EmptyState title="Could not read this agent" hint={message} />;
}

function ReadyBody({ state, path }: { state: Extract<LoadState, { kind: 'ready' }>; path: string }) {
  return (
    <>
      <div className="code-agent-banner" role="note">
        <Info size={16} strokeWidth={1.75} aria-hidden="true" />
        <span>
          Defined in code at <code>{path}</code>. Edit the files to change it.
        </span>
      </div>
      {state.warnings.length > 0 && (
        <ul className="code-agent-warnings">
          {state.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
      <div className="code-agent-body">
        <CodeAgentCanvas graph={state.graph} agentKey={path} />
      </div>
    </>
  );
}

/**
 * `#/w/:ws/code-agents/:path` (and the legacy `#/code-agents/:path`,
 * redirected by `useScreen`'s `codeAgentRedirect`) - reads `:ws`/`:path`
 * off the hash; the `:path` segment is the `CodeAgentItem.id` encoded
 * with `encodeURIComponent` (`agents%2Fsupport` is one segment), which
 * `matchRoute` decodes back to `agents/support`. While a legacy URL waits
 * on `GET /workspaces`, `ws` falls back to `launchId`.
 */
export function CodeAgentRoute() {
  const { path } = useRoute();
  const launchId = useWorkspacesMaybe()?.launchId;
  const route = matchRoute(`#${path}`, ['/w/:ws/code-agents/:path', '/code-agents/:path']);
  const agentPath = route?.params.path ?? '';
  const ws = route?.params.ws ?? launchId;
  if (ws === undefined) return null;
  return <CodeAgentScreen key={`${ws}/${agentPath}`} workspaceId={ws} path={agentPath} />;
}

export function CodeAgentScreen({ workspaceId, path }: { workspaceId: string; path: string }) {
  const state = useCodeAgentSpec(workspaceId, path);
  const { copying, copy } = useCopyIntoStudio(state.kind === 'ready' ? state.spec : undefined, workspaceId);
  const workspaces = useWorkspacesMaybe()?.list;
  const workspaceName = useMemo(() => workspaceLabel(workspaceId, workspaces), [workspaceId, workspaces]);
  // Until the spec loads, the header names the directory's last segment.
  const fallbackName = path === '.' ? path : (path.split('/').pop() ?? path);
  const title = state.kind === 'ready' ? state.spec.name : fallbackName;
  const description = state.kind === 'ready' ? state.spec.description : undefined;

  return (
    <>
      <ScreenHeader
        title={state.kind === 'loading' ? <Skeleton width={160} height={18} /> : title}
        description={description}
        breadcrumbs={[{ label: 'Agents', href: `#${agentListPath(workspaceId)}` }, { label: title }]}
        status={
          <span className="chip" title={workspaceId}>
            <Folder size={16} aria-hidden="true" />
            {workspaceName}
          </span>
        }
        actions={
          state.kind === 'ready' ? (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => void copy()}
              disabled={copying}
            >
              {copying ? 'Copying…' : 'Copy into Studio'}
            </button>
          ) : undefined
        }
      />
      <div className="code-agent-screen">
        {state.kind === 'loading' && <LoadingBody />}
        {state.kind === 'not-found' && <NotFoundBody workspaceId={workspaceId} />}
        {state.kind === 'error' && <ErrorBody message={state.message} />}
        {state.kind === 'ready' && <ReadyBody state={state} path={path} />}
      </div>
    </>
  );
}
