import { useEffect, useMemo, useState, type Key, type ReactElement } from 'react';
import type { ApiClient, PageUiView, UiComponent } from '@linuxdevil/lousho/workspaces/client';
import { IDLE_RUN, type RenderContext, type RunHandle } from './context';
import { useFormState, type FormCheck } from './form';
import { renderComponent } from './render';
import { isRecord } from './schema';

/** Props of {@link PageApp}. */
export interface PageAppProps {
  /** The client the host binds to its own server or proxy routes. */
  client: ApiClient;
  /** The workspace. */
  workspaceId: string;
  /** The page whose UI to render. */
  pageId: string;
  /** Run state and controls to use instead of the built-in ones, for hosts that drive runs themselves and for tests. */
  run?: RunHandle;
}

interface PageSpec {
  view: PageUiView;
  inputsSchema?: Record<string, unknown>;
}

type Loaded = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; spec: PageSpec };

async function loadSpec(client: ApiClient, workspaceId: string, pageId: string): Promise<PageSpec> {
  const params = { id: workspaceId, page: pageId };
  const [view, harness] = await Promise.all([client.call('getPageUi', { params }), client.call('getEffectiveHarness', { params })]);
  const schema = harness.effective.inputs?.schema;
  return { view, inputsSchema: isRecord(schema) ? schema : undefined };
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function usePageSpec(client: ApiClient, workspaceId: string, pageId: string): Loaded {
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' });
  useEffect(() => {
    let live = true;
    setLoaded({ state: 'loading' });
    void loadSpec(client, workspaceId, pageId).then(
      (spec) => live && setLoaded({ state: 'ready', spec }),
      (error: unknown) => live && setLoaded({ state: 'error', message: messageOf(error) })
    );
    return () => {
      live = false;
    };
  }, [client, workspaceId, pageId]);
  return loaded;
}

const NO_PROBLEMS: FormCheck = () => ({});

function LoadedPage({ props, spec }: { props: PageAppProps; spec: PageSpec }): ReactElement {
  const form = useFormState({}, NO_PROBLEMS);
  const run = props.run ?? IDLE_RUN;
  const ui = spec.view.ui;
  const ctx = useMemo<RenderContext>(() => {
    const context: RenderContext = {
      client: props.client,
      workspaceId: props.workspaceId,
      pageId: props.pageId,
      ui,
      inputsSchema: spec.inputsSchema,
      form,
      run,
      task: ui.title ?? props.pageId,
      render: (node: UiComponent, key: Key) => renderComponent(node, context, key),
    };
    return context;
  }, [props.client, props.workspaceId, props.pageId, ui, spec.inputsSchema, form, run]);
  return (
    <div className="lwr-root">
      {ui.title !== undefined && <h1 className="lwr-title">{ui.title}</h1>}
      {renderComponent(ui.layout, ctx)}
    </div>
  );
}

/** Renders a page's declarative UI (`lousho.ui/1`), loading its UI spec and effective input schema through `client`; the only way a page UI reaches the screen (R15). */
export function PageApp(props: PageAppProps): ReactElement {
  const loaded = usePageSpec(props.client, props.workspaceId, props.pageId);
  if (loaded.state === 'loading') return <p className="lwr-root" role="status">Loading the page</p>;
  if (loaded.state === 'error') return <p className="lwr-root lwr-error" role="alert">{loaded.message}</p>;
  return <LoadedPage key={`${props.workspaceId}/${props.pageId}`} props={props} spec={loaded.spec} />;
}
