import { useState } from 'react';
import { ArrowDown, ArrowUp, Trash2 } from 'lucide-react';
import type { PageDetail } from 'lousho/workspaces/client';
import { ConfirmDialog, Dialog } from '../../ui/Dialog';
import { EmptyState } from '../../ui/EmptyState';
import { Field } from '../../ui/Field';
import { Input, Textarea } from '../../ui/controls';
import { onRovingKeyDown } from '../rovingKeys';
import { useWorkspace } from './WorkspaceContext';
import { useWorkspacesClient } from './workspacesClient';
import type { MainHarness } from './workspaceTypes';

const KEBAB = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export function PagesSection() {
  const { workspace, ops } = useWorkspace();
  const client = useWorkspacesClient();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<PageDetail | undefined>(undefined);
  const [mainHarness, setMainHarness] = useState<MainHarness | undefined>(undefined);
  const [pageId, setPageId] = useState('');
  const [pageName, setPageName] = useState('');
  const [pageDescription, setPageDescription] = useState('');
  const [pageAgent, setPageAgent] = useState('agent');
  const pages = workspace.pages;

  const move = (index: number, delta: -1 | 1) => {
    const ids = pages.map((page) => page.id);
    const [id] = ids.splice(index, 1);
    ids.splice(index + delta, 0, id);
    void ops.send([{ op: 'reorder_pages', pages: ids }]);
  };

  const askRemove = (page: PageDetail) => {
    setRemoving(page);
    setMainHarness(undefined);
    void client
      .call('getMainHarness', { params: { id: workspace.id } })
      .then((view) => setMainHarness(view.harness))
      .catch(() => undefined);
  };

  const confirmRemove = () => {
    const page = removing;
    setRemoving(undefined);
    if (page !== undefined) void ops.send([{ op: 'remove_page', page: page.id }]);
  };

  const openAdd = () => {
    setPageId('');
    setPageName('');
    setPageDescription('');
    setPageAgent('agent');
    setAdding(true);
  };

  const idError = pageId !== '' && !KEBAB.test(pageId) ? 'Use kebab-case, e.g. tiktok-videos' : undefined;
  const canCreate =
    pageId !== '' && idError === undefined && pageName.trim() !== '' && pageDescription.trim() !== '' && pageAgent.trim() !== '' && !ops.pending;

  const create = async () => {
    const view = await ops.send([
      {
        op: 'create_page',
        page: pageId,
        name: pageName,
        description: pageDescription,
        execution: { type: 'single', single: { agent: pageAgent } },
      },
    ]);
    if (view !== undefined) {
      setAdding(false);
      setPageId('');
      setPageName('');
      setPageDescription('');
      setPageAgent('agent');
    }
  };

  const routesToPage = removing !== undefined && (mainHarness?.routes?.some((route) => route.page === removing.id) ?? false);

  return (
    <section className="ws-pages-section" aria-label="Pages">
      {pages.length > 0 ? (
        <div className="ws-pages-head">
          <button type="button" className="btn btn-sm" onClick={openAdd}>
            Add page
          </button>
        </div>
      ) : null}
      {pages.length === 0 ? (
        <EmptyState
          title="No pages yet"
          action={
            <button type="button" className="btn" onClick={openAdd}>
              Add page
            </button>
          }
        />
      ) : (
        <ul className="ws-pages" onKeyDown={onRovingKeyDown}>
          {pages.map((page, index) => (
            <li key={page.id} className="ws-page">
              <div className="ws-page-info">
                <span className="ws-page-name">{page.manifest.name}</span>
                <code className="ws-page-id">{page.id}</code>
                <span className="ws-page-desc">{page.manifest.description}</span>
                <span className="ws-page-type">{page.manifest.execution.type}</span>
              </div>
              <span className="ws-page-actions dt-actions">
                <button
                  type="button"
                  className="btn btn-sm"
                  data-roving
                  aria-label={`Move ${page.manifest.name} up`}
                  title={`Move ${page.manifest.name} up`}
                  disabled={index === 0 || ops.pending}
                  onClick={() => move(index, -1)}
                >
                  <ArrowUp size={14} strokeWidth={1.75} aria-hidden="true" />
                  Move up
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  aria-label={`Move ${page.manifest.name} down`}
                  title={`Move ${page.manifest.name} down`}
                  disabled={index === pages.length - 1 || ops.pending}
                  onClick={() => move(index, 1)}
                >
                  <ArrowDown size={14} strokeWidth={1.75} aria-hidden="true" />
                  Move down
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  aria-label={`Remove ${page.manifest.name}`}
                  title={`Remove ${page.manifest.name}`}
                  disabled={ops.pending}
                  onClick={() => askRemove(page)}
                >
                  <Trash2 size={14} strokeWidth={1.75} aria-hidden="true" />
                  Remove
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <Dialog
        open={adding}
        onClose={() => setAdding(false)}
        title="Add page"
        size="sm"
        description="Creates a single-agent page; the draft shows PRD018 until an agent with that alias is attached (P2.8)."
        footer={
          <>
            <button type="button" className="btn" onClick={() => setAdding(false)}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary" disabled={!canCreate} onClick={() => void create()}>
              Create
            </button>
          </>
        }
      >
        <div className="ws-add-fields">
          <Field id="add-page-id" label="Id" required error={idError} hint="Kebab-case; becomes the pages/ folder name.">
            <Input value={pageId} onChange={(event) => setPageId(event.target.value)} />
          </Field>
          <Field id="add-page-name" label="Name" required>
            <Input value={pageName} onChange={(event) => setPageName(event.target.value)} />
          </Field>
          <Field id="add-page-description" label="Description" required hint="The main agent routes on this">
            <Textarea value={pageDescription} onChange={(event) => setPageDescription(event.target.value)} />
          </Field>
          <Field id="add-page-agent" label="First agent alias" required hint="The page runs as a single agent with this alias.">
            <Input value={pageAgent} onChange={(event) => setPageAgent(event.target.value)} />
          </Field>
        </div>
      </Dialog>
      <ConfirmDialog
        open={removing !== undefined}
        title={removing === undefined ? 'Remove page?' : `Remove “${removing.manifest.name}”?`}
        description={
          removing === undefined ? (
            ''
          ) : (
            <>
              This deletes <code>pages/{removing.id}/</code> — page.json, harness/, agents.json, ui/ and resources/.
              {routesToPage ? ' The main harness routes to this page; that route will need fixing (PRD015).' : ''}
            </>
          )
        }
        confirmLabel="Remove page"
        pending={ops.pending}
        onConfirm={confirmRemove}
        onCancel={() => setRemoving(undefined)}
      />
    </section>
  );
}
