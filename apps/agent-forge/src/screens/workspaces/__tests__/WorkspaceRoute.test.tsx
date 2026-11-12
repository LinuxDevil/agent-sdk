import { describe, expect, it } from 'vitest';
import { ROUTE_NAMES, WorkspaceApiError } from 'lousho/workspaces/client';

import { WorkspaceRoute } from '../WorkspaceRoute';
import { buttonByName, click, conflict, flush, renderWithClient, spyClient, typeInto } from './workspaceTestKit';

const PAGES = '#/workspaces/marketing/pages';

describe('WorkspaceRoute', () => {
  it('the Overview form sends set_workspace_field with expectedRevision', async () => {
    window.location.hash = '#/workspaces/marketing/overview';
    const client = spyClient();
    const container = renderWithClient(<WorkspaceRoute />, client);
    await flush();
    typeInto(container.querySelector('#ws-overview-description'), 'Short videos for every channel.');
    click(buttonByName(container, 'Save'));
    await flush();
    expect(client.callsTo('applyOps')).toHaveLength(1);
    expect(client.callsTo('applyOps')[0].input).toEqual({
      params: { id: 'marketing' },
      body: {
        expectedRevision: 'rev-7d6e6f2ce202',
        ops: [{ op: 'set_workspace_field', field: 'description', value: 'Short videos for every channel.' }],
      },
    });
  });

  it('page reorder sends reorder_pages', async () => {
    window.location.hash = PAGES;
    const client = spyClient();
    const container = renderWithClient(<WorkspaceRoute />, client);
    await flush();
    click(buttonByName(container, 'Move Facebook up'));
    await flush();
    expect(client.callsTo('applyOps')).toHaveLength(1);
    expect(client.callsTo('applyOps')[0].input.body).toEqual({
      expectedRevision: 'rev-7d6e6f2ce202',
      ops: [{ op: 'reorder_pages', pages: ['facebook-videos', 'instagram-videos', 'content-research'] }],
    });
  });

  it('a 409 shows "changed since you opened it" and reloads', async () => {
    window.location.hash = PAGES;
    const client = spyClient({ applyOps: () => { throw conflict(); } });
    const container = renderWithClient(<WorkspaceRoute />, client);
    await flush();
    click(buttonByName(container, 'Move Facebook up'));
    await flush();
    expect(document.body.textContent).toContain('changed since you opened it');
    expect(client.callsTo('getWorkspace')).toHaveLength(2);
  });

  it('a second op in the same session reuses the draft id', async () => {
    window.location.hash = PAGES;
    const client = spyClient();
    const container = renderWithClient(<WorkspaceRoute />, client);
    await flush();
    click(buttonByName(container, 'Move Facebook up'));
    await flush();
    click(buttonByName(container, 'Move Facebook up'));
    await flush();
    expect(client.callsTo('applyOps')).toHaveLength(2);
    expect(client.callsTo('applyOps')[1].input.body).toMatchObject({ draftId: 'draft-0001' });
  });

  it('the header shows the revision, the problems badge and the open draft', async () => {
    window.location.hash = '#/workspaces/marketing';
    const client = spyClient();
    const container = renderWithClient(<WorkspaceRoute />, client);
    await flush();
    expect(container.textContent).toContain('rev-7d6e6f2ce202');
    expect(container.textContent).toContain('Valid');
    expect(container.textContent).toContain('Draft open');
    const draftButton = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Draft open');
    expect(draftButton?.getAttribute('title')).toBe('ali is editing');
  });

  it('the invalid badge shows the error count', async () => {
    window.location.hash = '#/workspaces/marketing';
    const problem = (code: string, severity: string) => ({ code, severity, file: 'workspace.json', path: '', message: code });
    const client = spyClient({
      getProblems: () => [problem('PRD017', 'error'), problem('PRD015', 'error'), problem('PRD025', 'warning')],
    });
    const container = renderWithClient(<WorkspaceRoute />, client);
    await flush();
    expect(container.textContent).toContain('Invalid (2)');
  });

  it('unbuilt sections name their ticket', async () => {
    window.location.hash = '#/workspaces/marketing/improve';
    const client = spyClient();
    const container = renderWithClient(<WorkspaceRoute />, client);
    await flush();
    expect(container.textContent).toContain('P5.36');
  });

  it('remove asks first and lists what is deleted', async () => {
    window.location.hash = PAGES;
    const client = spyClient();
    const container = renderWithClient(<WorkspaceRoute />, client);
    await flush();
    click(buttonByName(container, 'Remove Instagram'));
    await flush();
    const dialog = document.body.querySelector('[role="alertdialog"]');
    expect(dialog?.textContent).toContain('pages/instagram-videos/');
    expect(dialog?.textContent).toContain('PRD015');
    click(buttonByName(document.body, 'Remove page'));
    await flush();
    expect(client.callsTo('applyOps')).toHaveLength(1);
    expect(client.callsTo('applyOps')[0].input.body).toEqual({
      expectedRevision: 'rev-7d6e6f2ce202',
      ops: [{ op: 'remove_page', page: 'instagram-videos' }],
    });
  });

  it('add page sends create_page as a single page', async () => {
    window.location.hash = PAGES;
    const client = spyClient();
    const container = renderWithClient(<WorkspaceRoute />, client);
    await flush();
    click(buttonByName(container, 'Add page'));
    await flush();
    typeInto(document.body.querySelector('#add-page-id'), 'tiktok-videos');
    typeInto(document.body.querySelector('#add-page-name'), 'TikTok');
    typeInto(document.body.querySelector('#add-page-description'), 'Makes a TikTok video.');
    click(buttonByName(document.body, 'Create'));
    await flush();
    expect(client.callsTo('applyOps')).toHaveLength(1);
    expect(client.callsTo('applyOps')[0].input.body).toEqual({
      expectedRevision: 'rev-7d6e6f2ce202',
      ops: [
        {
          op: 'create_page',
          page: 'tiktok-videos',
          name: 'TikTok',
          description: 'Makes a TikTok video.',
          execution: { type: 'single', single: { agent: 'agent' } },
        },
      ],
    });
  });

  it('Chat opens the authoring chat sheet', async () => {
    window.location.hash = '#/workspaces/marketing';
    const client = spyClient();
    const container = renderWithClient(<WorkspaceRoute />, client);
    await flush();
    click(buttonByName(container, 'Chat'));
    await flush();
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain('P2.19');
  });

  it('an unknown workspace shows not found', async () => {
    window.location.hash = '#/workspaces/nope';
    const client = spyClient({ getWorkspace: () => { throw new WorkspaceApiError('no', 404); } });
    const container = renderWithClient(<WorkspaceRoute />, client);
    await flush();
    expect(container.textContent).toContain('Workspace not found');
  });

  it('makes no call outside WORKSPACE_ROUTES', async () => {
    const client = spyClient();
    window.location.hash = '#/workspaces/marketing/overview';
    renderWithClient(<WorkspaceRoute />, client);
    await flush();
    window.location.hash = PAGES;
    const container = renderWithClient(<WorkspaceRoute />, client);
    await flush();
    click(buttonByName(container, 'Move Facebook up'));
    await flush();
    click(buttonByName(container, 'Remove Instagram'));
    await flush();
    expect(client.calls.length).toBeGreaterThan(0);
    for (const call of client.calls) expect(ROUTE_NAMES).toContain(call.name);
  });
});
