import { randomUUID } from 'node:crypto';
import type { ApiClient } from '../workspaces/client/apiClient';
import type { WireRunEvent } from '../workspaces/client/wireTypes';

export interface RemoteOutput {
  line(text: string): void;
  json(value: unknown): void;
}

export interface RemoteRunOptions {
  workspace: string;
  page?: string;
  message: string;
  inputs?: unknown;
}

export function describeEvent(wire: WireRunEvent): string {
  const event = wire.event;
  if (event.type === 'step') return `step ${event.phase} ${event.page}`;
  if (event.type === 'finished') return `finished ${event.status}`;
  if (event.type === 'progress') return `progress ${event.message}`;
  return event.type;
}

export async function remoteList(client: ApiClient, workspace: string | undefined, out: RemoteOutput, asJson: boolean): Promise<number> {
  if (workspace === undefined) {
    const list = await client.call('listWorkspaces', {});
    if (asJson) out.json(list);
    else for (const item of list) out.line(`${item.id}\t${item.name}\t${item.pageCount} pages\t${item.revision}`);
    return 0;
  }
  const pages = await client.call('listPages', { params: { id: workspace } });
  if (asJson) out.json(pages);
  else for (const page of pages) out.line(`${page.id}\t${page.manifest.name}\t${page.manifest.execution.type}`);
  return 0;
}

export async function remoteShow(client: ApiClient, workspace: string, page: string | undefined, out: RemoteOutput, asJson: boolean): Promise<number> {
  if (page !== undefined) {
    const view = await client.call('getEffectiveHarness', { params: { id: workspace, page } });
    if (asJson) out.json(view);
    else {
      out.line(`page ${view.pageId} at ${view.revision} (harness ${view.hash})`);
      out.line(`layers: ${view.effective.sources.join(', ')}`);
    }
    return 0;
  }
  const detail = await client.call('getWorkspace', { params: { id: workspace } });
  if (asJson) out.json(detail);
  else {
    out.line(`${detail.id} ${detail.name} at ${detail.revision}`);
    for (const item of detail.pages) out.line(`  ${item.id}\t${item.manifest.execution.type}`);
  }
  return 0;
}

export async function remoteValidate(client: ApiClient, workspace: string, out: RemoteOutput, asJson: boolean): Promise<number> {
  const problems = await client.call('getProblems', { params: { id: workspace } });
  if (asJson) out.json(problems);
  else for (const item of problems) out.line(`${item.severity}\t${item.code}\t${item.file}${item.path === '' ? '' : `#${item.path}`}\t${item.message}`);
  return problems.some((item) => item.severity === 'error') ? 1 : 0;
}

export async function remoteRun(client: ApiClient, options: RemoteRunOptions, out: RemoteOutput, asJson: boolean): Promise<number> {
  const started =
    options.page === undefined
      ? await client.call('startWorkspaceRun', { params: { id: options.workspace }, body: { message: options.message, threadId: randomUUID() } })
      : await client.call('startPageRun', { params: { id: options.workspace, page: options.page }, body: { input: { pageId: options.page, task: options.message, inputs: options.inputs } } });
  let status = 'unknown';
  for await (const wire of client.streamRunEvents({ workspaceId: options.workspace, runId: started.runId })) {
    if (asJson) out.json(wire);
    else out.line(describeEvent(wire));
    if (wire.event.type === 'finished') status = wire.event.status;
  }
  return status === 'ok' ? 0 : 1;
}
