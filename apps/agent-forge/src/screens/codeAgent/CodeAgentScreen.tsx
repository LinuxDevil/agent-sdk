/**
 * X06b: `#/code-agents/:path` - one code-defined agent directory (found by
 * X06a's `GET /workspace/agent-dirs`) shown on the canvas read-only, with a
 * banner naming the directory and a "Copy into Studio" action that imports
 * the spec as a new Studio agent (L08a's `POST /agents/import`). The files
 * are never touched: edits happen in the files or in the Studio copy.
 */
import { useEffect, useState } from 'react';
import { Info } from 'lucide-react';
import type { AgentSpecV2 } from 'lousho';
import { stringify } from 'yaml';
import type { Graph } from '../../graph/v2/types';
import { specToGraph } from '../../graph/v2/specToGraph';
import { autoLayout } from '../../canvas/layout';
import { runtimeClient, RuntimeApiError } from '../../runtime/runtimeClient';
import { agentTabPath } from '../agents/agentTabs';
import { navigate } from '../../router/router';
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

/** Loads the directory's spec and lays its graph out; a new `path` restarts the load. */
function useCodeAgentSpec(path: string): LoadState {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    void (async () => {
      try {
        const { spec, warnings } = await runtimeClient.loadCodeAgentSpec(path);
        const graph = await graphFor(spec);
        if (!cancelled) setState({ kind: 'ready', spec, warnings, graph });
      } catch (error) {
        if (!cancelled) setState(errorState(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path]);
  return state;
}

/** "Copy into Studio": the spec as YAML through `POST /agents/import` (mode `new`), then open its canvas. */
function useCopyIntoStudio(spec: AgentSpecV2 | undefined) {
  const toast = useToast();
  const [copying, setCopying] = useState(false);
  const copy = async () => {
    if (spec === undefined || copying) return;
    setCopying(true);
    try {
      const record = await runtimeClient.importAgent({ text: stringify(spec), mode: 'new' });
      toast.show({
        message: `Copied as ${record.id}. Changes in Studio do not touch the files.`,
        tone: 'success',
      });
      navigate(agentTabPath(record.id, 'canvas'));
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

function NotFoundBody() {
  return (
    <EmptyState
      title="Agent directory not found"
      hint="It may have been moved or deleted."
      action={
        <a className="btn btn-secondary btn-sm" href="#/agents">
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

export function CodeAgentScreen({ path }: { path: string }) {
  const state = useCodeAgentSpec(path);
  const { copying, copy } = useCopyIntoStudio(state.kind === 'ready' ? state.spec : undefined);
  // Until the spec loads, the header names the directory's last segment.
  const fallbackName = path === '.' ? path : (path.split('/').pop() ?? path);
  const title = state.kind === 'ready' ? state.spec.name : fallbackName;
  const description = state.kind === 'ready' ? state.spec.description : undefined;

  return (
    <>
      <ScreenHeader
        title={state.kind === 'loading' ? <Skeleton width={160} height={18} /> : title}
        description={description}
        breadcrumbs={[{ label: 'Agents', href: '#/agents' }, { label: title }]}
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
        {state.kind === 'not-found' && <NotFoundBody />}
        {state.kind === 'error' && <ErrorBody message={state.message} />}
        {state.kind === 'ready' && <ReadyBody state={state} path={path} />}
      </div>
    </>
  );
}
