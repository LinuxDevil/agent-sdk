import { fixtureClient, type ApiClient, type HarnessView, type PageRunView, type PageUiView, type UiComponent, type UiContainer } from '@linuxdevil/lousho/workspaces/client';
import type { RunHandle } from '../context';

type Call = (name: string, input: unknown) => Promise<unknown>;

function overriding(base: ApiClient, change: (name: string, answer: unknown) => unknown): ApiClient {
  const call = (async (name: string, input: unknown) => change(name, await (base.call as Call)(name, input))) as ApiClient['call'];
  return { ...base, call };
}

function addAudienceInput(view: HarnessView): HarnessView {
  const schema = view.effective.inputs?.schema as Record<string, unknown>;
  const properties = { ...(schema.properties as Record<string, unknown>), audience: { type: 'string', enum: ['general', 'young-adults'] } };
  return { ...view, effective: { ...view.effective, inputs: { schema: { ...schema, properties } } } };
}

function addAudienceSelect(view: PageUiView): PageUiView {
  const layout = view.ui.layout as UiContainer;
  const children = [...layout.children];
  children.splice(3, 0, { type: 'select', bind: 'inputs.audience', label: 'Audience' });
  return { ...view, ui: { ...view.ui, layout: { ...layout, children } } };
}

export function withAudience(base: ApiClient = fixtureClient()): ApiClient {
  return overriding(base, (name, answer) => {
    if (name === 'getEffectiveHarness') return addAudienceInput(answer as HarnessView);
    if (name === 'getPageUi') return addAudienceSelect(answer as PageUiView);
    return answer;
  });
}

export function withUi(layout: UiComponent, base: ApiClient = withAudience()): ApiClient {
  return overriding(base, (name, answer) => (name === 'getPageUi' ? { ...(answer as PageUiView), ui: { schema: 'lousho.ui/1', layout } } : answer));
}

const settled = (): Promise<void> => Promise.resolve();

export function runWith(output: unknown, overrides: Partial<RunHandle> = {}): RunHandle {
  const view: PageRunView = {
    runId: 'run-0001',
    workspaceId: 'marketing',
    pageId: 'instagram-videos',
    status: 'ok',
    startedAt: '2026-11-10T09:00:00.000Z',
    result: { status: 'ok', output, artifacts: [], summary: 'Done.', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, runId: 'run-0001' },
  };
  return { available: true, status: 'ok', runId: 'run-0001', view, artifacts: [], start: settled, cancel: settled, approve: settled, ...overrides };
}
